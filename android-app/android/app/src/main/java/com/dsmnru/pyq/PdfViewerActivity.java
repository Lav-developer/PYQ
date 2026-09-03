package com.dsmnru.pyq;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Typeface;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.util.LruCache;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.view.WindowInsets;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * DSMNRU PYQ — in-app PDF viewer screen (pure Android, zero dependencies).
 *
 * "Open PDF" in the app opens THIS screen first. It:
 *   • streams the paper's ORIGINAL host URL directly (no Cloudflare Worker
 *     traffic, no CORS surface) into the app's *temporary cache* directory —
 *     the file is deleted when the viewer closes and stale files are purged,
 *     so nothing is permanently downloaded into app storage;
 *   • renders pages with the platform PdfRenderer (API 21+) lazily — visible
 *     pages render on demand into an LruCache, so a 100-page paper never
 *     allocates 100 bitmaps;
 *   • supports pinch-zoom + pan on a page and vertical page scrolling;
 *   • shows real progress / error states, with Retry and "Open externally"
 *     fallbacks (the SAME direct URL handed to a system PDF app — never the
 *     DSMNRU website);
 *   • sits on top of MainActivity, so system Back returns straight to the
 *     paper detail screen.
 */
public class PdfViewerActivity extends Activity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_TITLE = "title";

    private static final long MAX_BYTES = 40L * 1024 * 1024; // generous cap
    private static final long STALE_MS = 24L * 60 * 60 * 1000; // cache purge age
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final int MAX_PAGES = 400;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final AtomicBoolean cancelled = new AtomicBoolean(false);

    private String url = "";
    private String title = "Paper";
    private File pdfFile;

    private LinearLayout chrome;
    private TextView titleView;
    private TextView pageIndicator;
    private FrameLayout content;
    private LinearLayout loadingView;
    private ProgressBar progressBar;
    private TextView progressText;
    private LinearLayout errorView;
    private TextView errorText;
    private Button retryButton;
    private ScrollView reader;
    private LinearLayout pagesHost;

    private PdfRenderer renderer;
    private ParcelFileDescriptor pfd;
    private final Object rendererLock = new Object();
    private int pageCount = 0;
    private float pageAspect = 1.414f; // height/width, A4 default
    private BitmapLru pageCache;

    /** Bitmap cache bounded by heap share, not page count. */
    private static class BitmapLru extends LruCache<String, Bitmap> {
        BitmapLru(int maxSizeBytes) { super(maxSizeBytes); }
        @Override protected int sizeOf(String key, Bitmap value) {
            return value.getByteCount();
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        url = getIntent() != null ? getIntent().getStringExtra(EXTRA_URL) : null;
        title = getIntent() != null ? getIntent().getStringExtra(EXTRA_TITLE) : null;
        if (title == null || title.trim().isEmpty()) title = "Paper";
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            finish();
            return;
        }

        int heapShare = (int) Math.min(48L * 1024 * 1024,
                Runtime.getRuntime().maxMemory() / 6);
        pageCache = new BitmapLru(Math.max(heapShare, 16 * 1024 * 1024));

        buildUi();
        purgeStaleCacheFiles();
        loadPdf();
    }

    // ── UI construction (programmatic — brand slate + teal) ────────────

    private int dp(float v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0A101F"));

        chrome = new LinearLayout(this);
        chrome.setOrientation(LinearLayout.HORIZONTAL);
        chrome.setGravity(Gravity.CENTER_VERTICAL);
        chrome.setBackgroundColor(Color.parseColor("#0F172A"));
        chrome.setPadding(dp(6), dp(6), dp(6), dp(6));
        int chromePadH = dp(10);

        TextView back = new TextView(this);
        back.setText("‹");
        back.setTextSize(26);
        back.setTextColor(Color.WHITE);
        back.setPadding(chromePadH, 0, chromePadH, dp(2));
        back.setOnClickListener(v -> finish());
        chrome.addView(back, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, dp(44), 0));

        titleView = new TextView(this);
        titleView.setText(title);
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(15);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setSingleLine(true);
        titleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        titleView.setPadding(dp(6), 0, dp(6), 0);
        chrome.addView(titleView, new LinearLayout.LayoutParams(0, dp(44), 1f));

        pageIndicator = new TextView(this);
        pageIndicator.setTextColor(Color.parseColor("#6EE7D8"));
        pageIndicator.setTextSize(13);
        pageIndicator.setTypeface(Typeface.DEFAULT_BOLD);
        pageIndicator.setPadding(dp(4), 0, dp(8), 0);
        pageIndicator.setVisibility(View.GONE);
        chrome.addView(pageIndicator, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0));

        TextView external = new TextView(this);
        external.setText("↗");
        external.setTextSize(20);
        external.setTextColor(Color.parseColor("#6EE7D8"));
        external.setPadding(chromePadH, 0, chromePadH, 0);
        external.setOnClickListener(v -> openExternal());
        chrome.addView(external, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, dp(44), 0));

        root.addView(chrome, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        content = new FrameLayout(this);

        // loading
        loadingView = new LinearLayout(this);
        loadingView.setOrientation(LinearLayout.VERTICAL);
        loadingView.setGravity(Gravity.CENTER);
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setIndeterminate(true);
        LinearLayout.LayoutParams pbLp = new LinearLayout.LayoutParams(dp(220), ViewGroup.LayoutParams.WRAP_CONTENT);
        progressText = new TextView(this);
        progressText.setTextColor(Color.parseColor("#CBD5E1"));
        progressText.setTextSize(14);
        progressText.setGravity(Gravity.CENTER);
        progressText.setPadding(0, dp(14), 0, 0);
        loadingView.addView(progressBar, pbLp);
        loadingView.addView(progressText, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        content.addView(loadingView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        // error
        errorView = new LinearLayout(this);
        errorView.setOrientation(LinearLayout.VERTICAL);
        errorView.setGravity(Gravity.CENTER);
        errorText = new TextView(this);
        errorText.setTextColor(Color.parseColor("#FFB4B6"));
        errorText.setTextSize(14);
        errorText.setGravity(Gravity.CENTER);
        errorText.setPadding(dp(28), 0, dp(28), 0);
        retryButton = button("Try again");
        retryButton.setOnClickListener(v -> loadPdf());
        Button openBtn = button("Open in another app");
        openBtn.setOnClickListener(v -> openExternal());
        LinearLayout errBtns = new LinearLayout(this);
        errBtns.setOrientation(LinearLayout.HORIZONTAL);
        errBtns.setGravity(Gravity.CENTER);
        errBtns.addView(retryButton);
        errBtns.addView(openBtn);
        errorView.addView(errorText, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        errorView.addView(errBtns, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        errorView.setVisibility(View.GONE);
        content.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        // reader
        reader = new ScrollView(this);
        reader.setFillViewport(true);
        reader.setBackgroundColor(Color.parseColor("#1E293B"));
        reader.getViewTreeObserver().addOnScrollChangedListener(this::renderVisiblePages);
        pagesHost = new LinearLayout(this);
        pagesHost.setOrientation(LinearLayout.VERTICAL);
        int pageGap = dp(8);
        pagesHost.setPadding(0, pageGap, 0, pageGap);
        reader.addView(pagesHost, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        reader.setVisibility(View.GONE);
        content.addView(reader, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(content, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
        applyInsets(root);
    }

    private Button button(String label) {
        Button b = new Button(this, null, 0);
        b.setText(label);
        b.setTextColor(Color.parseColor("#04211D"));
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setAllCaps(false);
        b.setBackground(androidx.core.content.ContextCompat.getDrawable(this, R.drawable.pdf_viewer_btn));
        b.setPadding(dp(16), 0, dp(16), 0);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, dp(44));
        lp.setMargins(dp(6), dp(14), dp(6), 0);
        b.setLayoutParams(lp);
        return b;
    }

    /** Content must clear the status bar on Android 15+ edge-to-edge too. */
    private void applyInsets(View root) {
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top;
            if (Build.VERSION.SDK_INT >= 30) {
                top = insets.getInsets(WindowInsets.Type.systemBars()).top;
            } else {
                @SuppressWarnings("deprecation")
                int legacy = insets.getSystemWindowInsetTop();
                top = legacy;
            }
            chrome.setPadding(chrome.getPaddingLeft(), top, chrome.getPaddingRight(), chrome.getPaddingBottom());
            if (Build.VERSION.SDK_INT >= 30) return insets;
            @SuppressWarnings("deprecation")
            WindowInsets consumed = insets.consumeSystemWindowInsets();
            return consumed;
        });
    }

    // ── state switching ────────────────────────────────────────────────

    private void showLoading(String text) {
        loadingView.setVisibility(View.VISIBLE);
        errorView.setVisibility(View.GONE);
        reader.setVisibility(View.GONE);
        progressText.setText(text);
    }

    private void showError(String message) {
        loadingView.setVisibility(View.GONE);
        errorView.setVisibility(View.VISIBLE);
        reader.setVisibility(View.GONE);
        errorText.setText(message);
    }

    private void showReader() {
        loadingView.setVisibility(View.GONE);
        errorView.setVisibility(View.GONE);
        reader.setVisibility(View.VISIBLE);
        pageIndicator.setVisibility(View.VISIBLE);
    }

    // ── download ───────────────────────────────────────────────────────

    private File cacheDir() {
        File dir = new File(getCacheDir(), "pdfview");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private void purgeStaleCacheFiles() {
        File dir = cacheDir();
        File[] files = dir.listFiles();
        if (files == null) return;
        long now = System.currentTimeMillis();
        for (File f : files) {
            if (now - f.lastModified() > STALE_MS) f.delete();
        }
    }

    private static String cacheKeyFor(String url) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] dig = md.digest(url.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 12; i++) sb.append(String.format("%02x", dig[i]));
            return sb.toString();
        } catch (Exception e) {
            return String.valueOf(url.hashCode());
        }
    }

    /** Executor submit that survives a destroy-while-loading race. */
    private void safeExecute(Runnable task) {
        try {
            io.execute(task);
        } catch (Exception rejected) {
            // activity already destroyed — ignore
        }
    }

    private void loadPdf() {
        cancelled.set(false);
        showLoading("Preparing the paper…");
        progressBar.setIndeterminate(true);
        safeExecute(() -> {
            try {
                File target = new File(cacheDir(), cacheKeyFor(url) + ".pdf");
                pdfFile = target;
                downloadToFile(url, target);
                if (cancelled.get()) return;
                main.post(this::openRenderer);
            } catch (Exception e) {
                if (cancelled.get()) return;
                String msg = e.getMessage() == null ? "Download failed" : e.getMessage();
                main.post(() -> showError(msg));
            }
        });
    }

    private void downloadToFile(String sourceUrl, File target) throws Exception {
        // Reuse a complete, verified copy of THIS url when it is still cached
        // (e.g. quick close/re-open) — otherwise stream a fresh one.
        if (target.exists() && target.length() > 4 && target.lastModified() > System.currentTimeMillis() - STALE_MS) {
            return;
        }
        File partial = new File(target.getAbsolutePath() + ".part");
        HttpURLConnection conn = null;
        try {
            URL u = new URL(sourceUrl);
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", "DSMNRU-PYQ-Android/2 (in-app pdf viewer)");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new Exception("The paper host answered with HTTP " + code);
            }
            long total = conn.getContentLengthLong();
            boolean magicChecked = false;
            long written = 0;
            byte[] pending = new byte[0]; // leading bytes awaiting the %PDF check
            try (InputStream in = conn.getInputStream();
                 OutputStream out = new FileOutputStream(partial)) {
                byte[] buf = new byte[16384];
                long lastUi = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (cancelled.get()) return;
                    if (!magicChecked) {
                        byte[] combined = new byte[pending.length + n];
                        System.arraycopy(pending, 0, combined, 0, pending.length);
                        System.arraycopy(buf, 0, combined, pending.length, n);
                        // The %PDF magic must appear within the first 1 KB; if we
                        // still don't have enough bytes, keep buffering.
                        if (combined.length >= 1024 || n < buf.length) {
                            if (!looksLikePdf(combined)) {
                                throw new Exception("This link is not a direct PDF file — try the other server or open it externally.");
                            }
                            magicChecked = true;
                            out.write(combined, 0, combined.length);
                            written += combined.length;
                            pending = new byte[0];
                        } else {
                            pending = combined;
                        }
                        continue;
                    }
                    out.write(buf, 0, n);
                    written += n;
                    long now = System.currentTimeMillis();
                    if (now - lastUi > 200) {
                        lastUi = now;
                        updateProgress(written, total);
                    }
                    if (written > MAX_BYTES) {
                        throw new Exception("This file is too large for the in-app viewer (over 40 MB) — download it instead.");
                    }
                }
                if (!magicChecked) {
                    if (!looksLikePdf(pending)) {
                        throw new Exception("This link is not a direct PDF file — try the other server or open it externally.");
                    }
                    out.write(pending);
                    written += pending.length;
                }
            }
            if (!partial.renameTo(target)) {
                throw new Exception("Could not store the temporary copy.");
            }
            updateProgress(1, 1);
        } finally {
            if (conn != null) conn.disconnect();
            partial.delete();
        }
    }

    private static boolean looksLikePdf(byte[] head) {
        for (int i = 0; i <= Math.max(0, head.length - 4) && i < 1024; i++) {
            if (head[i] == '%' && i + 4 <= head.length
                    && head[i + 1] == 'P' && head[i + 2] == 'D' && head[i + 3] == 'F') {
                return true;
            }
        }
        return false;
    }

    private void updateProgress(long written, long total) {
        main.post(() -> {
            if (cancelled.get()) return;
            if (total > 0) {
                progressBar.setIndeterminate(false);
                progressBar.setMax(1000);
                progressBar.setProgress((int) Math.min(1000, written * 1000 / total));
                long totalKb = total / 1024;
                progressText.setText("Downloading… " + (written / 1024) + " / " + totalKb + " KB");
            } else {
                progressBar.setIndeterminate(true);
                progressText.setText("Downloading… " + (written / 1024) + " KB");
            }
        });
    }

    // ── rendering ──────────────────────────────────────────────────────

    private void openRenderer() {
        try {
            pfd = ParcelFileDescriptor.open(pdfFile, ParcelFileDescriptor.MODE_READ_ONLY);
            renderer = new PdfRenderer(pfd);
            pageCount = Math.min(renderer.getPageCount(), MAX_PAGES);
            synchronized (rendererLock) {
                PdfRenderer.Page first = renderer.openPage(0);
                pageAspect = first.getHeight() / (float) first.getWidth();
                first.close();
            }
        } catch (Exception e) {
            showError("This PDF could not be opened in the app (" + e.getMessage() + "). Try downloading it instead.");
            return;
        }
        pagesHost.removeAllViews();
        int gap = dp(8);
        for (int i = 0; i < pageCount; i++) {
            PageImageView slot = new PageImageView(this, i + 1, pageAspect);
            pagesHost.addView(slot);
            if (i < pageCount - 1) {
                LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) slot.getLayoutParams();
                lp.bottomMargin = gap;
            }
        }
        showReader();
        pagesHost.post(this::renderVisiblePages);
    }

    /** Render every page slot currently (or nearly) on screen, lazily. */
    private void renderVisiblePages() {
        if (renderer == null || pagesHost.getChildCount() == 0) return;
        int scrollY = reader.getScrollY();
        int viewport = reader.getHeight();
        int width = pagesHost.getWidth();
        if (width <= 0) return;
        int margin = viewport / 2;
        int top = scrollY - margin;
        int bottom = scrollY + viewport + margin;
        int acc = 0;
        int firstVisible = -1;
        for (int i = 0; i < pagesHost.getChildCount(); i++) {
            View child = pagesHost.getChildAt(i);
            int childTop = acc;
            int childBottom = acc + child.getHeight() + ((LinearLayout.LayoutParams) child.getLayoutParams()).bottomMargin;
            acc = childBottom;
            if (childBottom < top || childTop > bottom) continue;
            if (firstVisible == -1 && childBottom > scrollY) firstVisible = i;
            if (child instanceof PageImageView) {
                renderPageInto((PageImageView) child, i, width);
            }
        }
        if (firstVisible == -1) firstVisible = 0;
        final int pageShown = firstVisible + 1;
        pageIndicator.setText(pageShown + " / " + pageCount);
    }

    private void renderPageInto(final PageImageView slot, final int index, final int viewWidth) {
        final String key = "p" + index;
        Bitmap cached = pageCache.get(key);
        if (cached != null) {
            slot.setPageBitmap(cached);
            return;
        }
        if (slot.isRendering()) return;
        slot.setRendering(true);
        safeExecute(() -> {
            Bitmap bmp = null;
            try {
                synchronized (rendererLock) {
                    if (renderer == null || cancelled.get()) return;
                    bmp = pageCache.get(key);
                    if (bmp == null) {
                        PdfRenderer.Page page = renderer.openPage(index);
                        try {
                            int ptW = page.getWidth();
                            int ptH = page.getHeight();
                            float density = getResources().getDisplayMetrics().density;
                            int targetW = Math.max(Math.round(viewWidth * 1.75f),
                                    Math.round(ptW * density * 1.6f));
                            targetW = Math.min(targetW, 1800);
                            int targetH = Math.round(targetW * (ptH / (float) ptW));
                            bmp = Bitmap.createBitmap(targetW, targetH, Bitmap.Config.ARGB_8888);
                            bmp.eraseColor(Color.WHITE);
                            page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                            pageCache.put(key, bmp);
                        } finally {
                            page.close();
                        }
                    }
                }
            } catch (Exception e) {
                bmp = null;
            } finally {
                final Bitmap result = bmp;
                main.post(() -> {
                    slot.setRendering(false);
                    if (result != null) slot.setPageBitmap(result);
                });
            }
        });
    }

    // ── external fallback ──────────────────────────────────────────────

    private void openExternal() {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app on this device can open that link", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Could not open the link", Toast.LENGTH_SHORT).show();
        }
    }

    // ── lifecycle ──────────────────────────────────────────────────────

    @Override
    protected void onDestroy() {
        cancelled.set(true);
        io.shutdown();
        synchronized (rendererLock) {
            try { if (renderer != null) renderer.close(); } catch (Exception ignored) { }
            renderer = null;
        }
        try { if (pfd != null) pfd.close(); } catch (Exception ignored) { }
        pfd = null;
        // Temporary copy only: nothing permanent is kept in app storage.
        if (pdfFile != null) pdfFile.delete();
        super.onDestroy();
    }

    // ── zoomable page view ─────────────────────────────────────────────

    /** One rendered page: pinch-zoom + pan with a matrix, vertical scroll at 1x. */
    private final class PageImageView extends androidx.appcompat.widget.AppCompatImageView {

        private final int pageNumber;
        private final Matrix draw = new Matrix();
        private final ScaleGestureDetector scaleDetector;
        private final android.view.GestureDetector gestureDetector;
        private boolean rendering = false;
        private float scale = 1f;
        private float lastTouchX = 0f;
        private float lastTouchY = 0f;
        /** The bitmap currently attached to this view (ImageView has no getter). */
        private Bitmap displayed;

        PageImageView(android.content.Context context, int pageNumber, float aspect) {
            super(context);
            this.pageNumber = pageNumber;
            setBackgroundColor(Color.parseColor("#0F172A"));
            setScaleType(ScaleType.MATRIX);
            setPagePlaceholder(aspect);

            scaleDetector = new ScaleGestureDetector(context, new ScaleListener());
            gestureDetector = new android.view.GestureDetector(context, new GestureListener());
        }

        @Override
        protected void onSizeChanged(int w, int h, int oldw, int oldh) {
            super.onSizeChanged(w, h, oldw, oldh);
            // The fit matrix needs the real view size — reapply once measured.
            if (w > 0 && h > 0 && scale == 1f) resetMatrix();
        }

        void setPagePlaceholder(float aspect) {
            int width = getResources().getDisplayMetrics().widthPixels;
            int height = Math.round(width * aspect);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, height);
            setLayoutParams(lp);
            Bitmap ph = Bitmap.createBitmap(8, Math.max(1, Math.round(8 * aspect)), Bitmap.Config.ARGB_8888);
            ph.eraseColor(Color.parseColor("#16213B"));
            displayed = ph;
            setImageBitmap(ph);
            resetMatrix();
        }

        boolean isRendering() { return rendering; }
        void setRendering(boolean value) { rendering = value; }

        void setPageBitmap(Bitmap bitmap) {
            // Same instance already attached (LruCache hit on a re-scroll) —
            // keep the current matrix instead of resetting an ongoing zoom.
            if (displayed == bitmap) return;
            displayed = bitmap;
            setImageBitmap(bitmap);
            resetMatrix();
        }

        private void resetMatrix() {
            scale = 1f;
            draw.reset();
            // Fit the (aspect-matched) bitmap exactly to the view bounds.
            android.graphics.drawable.Drawable d = getDrawable();
            if (d != null && getWidth() > 0 && d.getIntrinsicWidth() > 0) {
                float fit = getWidth() / (float) d.getIntrinsicWidth();
                draw.setScale(fit, fit);
            }
            setImageMatrix(draw);
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            scaleDetector.onTouchEvent(event);
            gestureDetector.onTouchEvent(event); // double-tap zoom

            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    lastTouchX = event.getX();
                    lastTouchY = event.getY();
                    if (scale > 1f) parent().requestDisallowInterceptTouchEvent(true);
                    break;
                case MotionEvent.ACTION_MOVE:
                    if (scale > 1f && !scaleDetector.isInProgress()) {
                        // Raw finger delta: positive X = finger moved right →
                        // the page must follow the finger (no scroll-sign maths).
                        panBy(event.getX() - lastTouchX, event.getY() - lastTouchY);
                    }
                    lastTouchX = event.getX();
                    lastTouchY = event.getY();
                    if (scale > 1f) parent().requestDisallowInterceptTouchEvent(true);
                    break;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (scale <= 1f) parent().requestDisallowInterceptTouchEvent(false);
                    break;
                default:
                    break;
            }
            return true;
        }

        private ViewGroup parent() {
            return (ViewGroup) getParent();
        }

        private void applyScale(float factor, float focusX, float focusY) {
            float next = Math.max(1f, Math.min(4f, scale * factor));
            factor = next / scale;
            scale = next;
            draw.postScale(factor, factor, focusX, focusY);
            clampTranslation();
            setImageMatrix(draw);
        }

        private void panBy(float dx, float dy) {
            draw.postTranslate(dx, dy);
            clampTranslation();
            setImageMatrix(draw);
        }

        /** Keep the zoomed image covering the view — no empty gaps. */
        private void clampTranslation() {
            if (getDrawable() == null) return;
            android.graphics.RectF bounds = new android.graphics.RectF(0, 0,
                    getDrawable().getIntrinsicWidth(), getDrawable().getIntrinsicHeight());
            draw.mapRect(bounds);
            android.graphics.RectF view = new android.graphics.RectF(0, 0, getWidth(), getHeight());
            float dx = 0, dy = 0;
            if (bounds.left > view.left) dx = view.left - bounds.left;
            else if (bounds.right < view.right) dx = view.right - bounds.right;
            if (bounds.top > view.top) dy = view.top - bounds.top;
            else if (bounds.bottom < view.bottom) dy = view.bottom - bounds.bottom;
            if (dx != 0 || dy != 0) draw.postTranslate(dx, dy);
        }

        private final class ScaleListener extends ScaleGestureDetector.SimpleOnScaleGestureListener {
            @Override public boolean onScale(ScaleGestureDetector detector) {
                applyScale(detector.getScaleFactor(), detector.getFocusX(), detector.getFocusY());
                return true;
            }
        }

        private final class GestureListener extends android.view.GestureDetector.SimpleOnGestureListener {
            @Override public boolean onDown(MotionEvent e) { return true; }

            @Override public boolean onDoubleTap(MotionEvent e) {
                if (scale > 1f) {
                    resetMatrix();
                } else {
                    applyScale(2.5f, e.getX(), e.getY());
                }
                return true;
            }
        }
    }
}
