// Paper detail page logic - standalone but shares Firebase from script.js
(function() {
    // Ensure Firebase is initialized (script.js already does it, but guard)
    if (!firebase.apps.length) {
        const firebaseConfig = {
            apiKey: "AIzaSyBRlsk-knQs-AMlaTFxlneBMTwlSfwyFaQ",
            authDomain: "dsmnru-data.firebaseapp.com",
            projectId: "dsmnru-data",
            storageBucket: "dsmnru-data.firebasestorage.app",
            messagingSenderId: "62250453477",
            appId: "1:62250453477:web:087c07403e4fead220470c",
            measurementId: "G-VL6V3T96YX"
        };
        firebase.initializeApp(firebaseConfig);
    }
    const db = firebase.firestore();
    const auth = firebase.auth();

    // ===== CLIENT CACHE (shared with index — 0 reads on related if cache hit) =====
    const PYQS_CACHE_KEY = 'dsmnru_pyqs_full_v1';
    const PYQS_CACHE_TIME_KEY = 'dsmnru_pyqs_full_time_v1';
    const PYQS_SESSION_KEY = 'dsmnru_pyqs_session_v1';
    const PYQS_CACHE_TTL_MS = 15 * 60 * 1000;
    function getCachedPyqsFullForPaper() {
        try {
            const sess = sessionStorage.getItem(PYQS_SESSION_KEY);
            if (sess) { try { return JSON.parse(sess); } catch(e){} }
            const raw = localStorage.getItem(PYQS_CACHE_KEY);
            const t = parseInt(localStorage.getItem(PYQS_CACHE_TIME_KEY) || '0', 10);
            if (!raw || !t) return null;
            if (Date.now() - t > PYQS_CACHE_TTL_MS) return null;
            const data = JSON.parse(raw);
            try { sessionStorage.setItem(PYQS_SESSION_KEY, raw); } catch(e){}
            return data;
        } catch(e){ return null; }
    }

    // Verification helpers (must match script.js logic)
    function isGoogleUserPaper(user) {
        if (!user || !Array.isArray(user.providerData)) return false;
        return user.providerData.some(p => p && p.providerId === 'google.com');
    }
    function requiresEmailVerificationPaper(user) {
        return !!user && !isGoogleUserPaper(user) && !user.emailVerified;
    }
    let _paperVerificationBlockEl = null;
    function ensurePaperVerificationBlock() {
        if (_paperVerificationBlockEl) return _paperVerificationBlockEl;
        _paperVerificationBlockEl = document.createElement('div');
        _paperVerificationBlockEl.id = 'paperVerificationBlock';
        _paperVerificationBlockEl.style.cssText = 'position:fixed;inset:0;background:rgba(2,6,23,0.92);backdrop-filter:blur(8px);z-index:1085;display:none;align-items:center;justify-content:center;padding:1rem;';
        _paperVerificationBlockEl.innerHTML = `<div style="max-width:460px;width:100%;background:linear-gradient(180deg, rgba(15,23,42,0.96), rgba(15,23,42,0.88));border:1px solid rgba(110,231,216,0.22);border-radius:22px;padding:1.5rem 1.25rem;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,0.5);"><div style="width:64px;height:64px;margin:0 auto 12px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#f59e0b,#f97316);color:#fff;font-size:1.6rem;"><i class="fas fa-envelope"></i></div><h5 style="color:#f8fafc;font-weight:800;margin:0 0 8px;">Verify your email to continue</h5><p style="color:rgba(203,213,225,0.78);font-size:13px;line-height:1.5;margin:0 0 14px;">We sent a link to <strong id="paperVerificationBlockEmail" style="color:#f8fafc;"></strong>. Verify to preview, download and comment.</p><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" onclick="resendVerificationEmail()"><i class="fas fa-redo me-1"></i> Resend</button><button class="btn btn-outline-light btn-sm" onclick="checkEmailVerification()"><i class="fas fa-check me-1"></i> I verified</button><button class="btn btn-outline-danger btn-sm" onclick="logoutAndChangeEmail()">Use different email</button></div></div>`;
        document.body.appendChild(_paperVerificationBlockEl);
        return _paperVerificationBlockEl;
    }
    function showPaperVerificationBlock() {
        if (!currentUser) return;
        const block = ensurePaperVerificationBlock();
        const el = document.getElementById('paperVerificationBlockEmail');
        if (el) el.textContent = currentUser.email;
        if (block) block.style.display = 'flex';
        const modalEl = document.getElementById('emailVerificationModal');
        if (modalEl) {
            const m = bootstrap.Modal.getOrCreateInstance(modalEl, {backdrop:'static', keyboard:false});
            m.show();
            modalEl.addEventListener('hidden.bs.modal', function h(){
                if (currentUser && requiresEmailVerificationPaper(currentUser)) {
                    setTimeout(()=>{ const mm=bootstrap.Modal.getOrCreateInstance(modalEl,{backdrop:'static',keyboard:false}); mm.show(); },200);
                } else {
                    modalEl.removeEventListener('hidden.bs.modal', h);
                    if (block) block.style.display='none';
                }
            });
        }
    }
    function hidePaperVerificationBlock(){
        const b=document.getElementById('paperVerificationBlock');
        if(b) b.style.display='none';
        const me=document.getElementById('emailVerificationModal');
        if(me) try{ bootstrap.Modal.getInstance(me)?.hide(); }catch(e){}
    }
    function isPaperVerifiedOrPrompt(){
        if (currentUser && requiresEmailVerificationPaper(currentUser)) { showPaperVerificationBlock(); return false; }
        return true;
    }
    // Helpers
    function getParam(name) { return new URLSearchParams(window.location.search).get(name); }
    function escapeHtml(v){ return String(v||'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function escapeJs(v){ return String(v||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\r?\n/g,' '); }
    function normalizeLink(v){
        const t = String(v||'').trim();
        if(!t || t.toLowerCase()==='null') return '';
        return t;
    }
    function getPrimaryLink(doc){ return normalizeLink(doc.file || doc.server1 || ''); }
    function getSecondaryLink(doc){ return normalizeLink(doc.file2 || doc.server2 || ''); }
    function isDirectPdfUrl(u){
        try { const clean = u.split('#')[0].split('?')[0].toLowerCase(); return clean.endsWith('.pdf'); } catch(e){ return false; }
    }
    function isMediaFireUrl(u){
        try { return new URL(u).hostname.toLowerCase().includes('mediafire.com'); } catch(e){ return /mediafire\.com/i.test(u); }
    }
    function getPreviewMeta(url){
        if(isDirectPdfUrl(url) && !isMediaFireUrl(url)) return { label: 'Preview', icon: 'fas fa-eye' };
        return { label: 'Open Link', icon: 'fas fa-external-link-alt' };
    }
    function loadPreviewOnSameSite(url, title){
        // Stay on same site — load URL into the main preview frame instead of window.open
        if (!currentUser) { if (typeof openSearchGateModal === 'function') openSearchGateModal(); else openLoginModal(); return; }
        if (requiresEmailVerificationPaper(currentUser)) { showPaperVerificationBlock(); return; }
        incrementViews(currentPaper.id);
        // Show in main inline preview (works for catbox/archive direct PDFs; details pages will show inside frame if allowed)
        previewContainerEl.innerHTML = `<div class="paper-preview-frame"><iframe src="${escapeHtml(url)}" title="${escapeHtml(title)} preview" loading="lazy" referrerpolicy="no-referrer"></iframe></div>`;
        previewHintEl.textContent = `Previewing ${title} — same-site viewer`;
        downloadAltEl.innerHTML = `<small style="color: rgba(203,213,225,0.6);">If the preview is blank due to the host blocking embeds, use the modal preview button.</small>`;
        // Smooth scroll to preview
        setTimeout(()=>{ try{ previewContainerEl.scrollIntoView({behavior:'smooth', block:'center'}); }catch(e){} }, 100);
    }
    function formatDate(ts){
        if(!ts) return '-';
        try {
            const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
            return d.toLocaleDateString('en-IN', { year:'numeric', month:'short', day:'numeric' });
        } catch(e){ return '-'; }
    }

    // DOM refs
    const loadingEl = document.getElementById('paperLoading');
    const errorEl = document.getElementById('paperError');
    const errorMsgEl = document.getElementById('paperErrorMessage');
    const contentEl = document.getElementById('paperContent');
    const extraEl = document.getElementById('paperExtra');
    const breadcrumbEl = document.getElementById('paperBreadcrumb');
    const titleEl = document.getElementById('paperTitle');
    const kickerEl = document.getElementById('paperKicker');
    const metaRowEl = document.getElementById('paperMetaRow');
    const submetaEl = document.getElementById('paperSubmeta');
    const actionsBarEl = document.getElementById('paperActionsBar');
    const previewContainerEl = document.getElementById('paperPreviewContainer');
    const previewHintEl = document.getElementById('paperPreviewHint');
    const downloadAltEl = document.getElementById('paperDownloadAlt');
    const infoListEl = document.getElementById('paperInfoList');
    const paperLockOverlayEl = document.getElementById('paperLockOverlay');
    const relatedSectionEl = document.getElementById('relatedSection');
    const relatedGridEl = document.getElementById('relatedGrid');
    const relatedSubtitleEl = document.getElementById('relatedSubtitle');
    const commentForm = document.getElementById('commentForm');
    const commentText = document.getElementById('commentText');
    const commentCharCount = document.getElementById('commentCharCount');
    const commentListEl = document.getElementById('commentList');
    const commentAuthPromptEl = document.getElementById('commentAuthPrompt');
    const commentErrorEl = document.getElementById('commentError');
    const commentSuccessEl = document.getElementById('commentSuccess');

    let currentPaper = null;
    let currentPaperId = null;
    let currentUser = null;

    // Auth listener for comment UI + paper lock + email verification (forces signup + verification)
    auth.onAuthStateChanged(user => {
        currentUser = user || null;
        updateCommentAuthUI();
        updatePaperLockUI();
        if (!user) {
            hidePaperVerificationBlock();
        } else {
            // check verification after reload
            user.reload().then(() => {
                if (requiresEmailVerificationPaper(user)) {
                    showPaperVerificationBlock();
                } else {
                    hidePaperVerificationBlock();
                }
            }).catch(()=>{ if (requiresEmailVerificationPaper(user)) showPaperVerificationBlock(); });
        }
    });
    function updateCommentAuthUI(){
        if(currentUser){
            commentAuthPromptEl.style.display = 'none';
            commentText.disabled = false;
        } else {
            commentAuthPromptEl.style.display = 'flex';
        }
    }
    function updatePaperLockUI(){
        if (!paperLockOverlayEl || !document.getElementById('paperContent')) return;
        // only apply after paper is loaded; otherwise keep hidden
        if (!currentPaper) {
            paperLockOverlayEl.style.display = 'none';
            document.getElementById('paperContent')?.classList.remove('locked');
            return;
        }
        const isLocked = !currentUser;
        const card = document.getElementById('paperContent');
        if (isLocked) {
            paperLockOverlayEl.style.display = 'flex';
            card.classList.add('locked');
        } else {
            paperLockOverlayEl.style.display = 'none';
            card.classList.remove('locked');
        }
    }
    // expose helpers for inline onclick that should gate
    window._paperRequiresLogin = function(){
        if (!currentUser) {
            // use same search gate modal if available (from script.js), else fallback to login
            if (typeof openSearchGateModal === 'function') openSearchGateModal();
            else openLoginModal();
            return true;
        }
        return false;
    };

    // Main load
    async function init(){
        const id = getParam('id');
        if(!id){
            showError('No paper ID provided.', 'Please open a paper from the home page. Add ?id=PAPER_ID to the URL.');
            return;
        }
        currentPaperId = id.trim();
        try {
            await loadPaper(currentPaperId);
        } catch(err){
            console.error(err);
            showError('Failed to load paper.', err.message || 'Please try again later.');
        }
    }

    function showError(title, msg){
        loadingEl.style.display = 'none';
        contentEl.style.display = 'none';
        extraEl.style.display = 'none';
        relatedSectionEl.style.display = 'none';
        errorEl.style.display = 'block';
        if(title) errorEl.querySelector('h3').textContent = title;
        if(msg) errorMsgEl.textContent = msg;
        // breadcrumb
        breadcrumbEl.innerHTML = `
            <li><a href="index.html"><i class="fas fa-home"></i> Home</a><span class="sep">/</span></li>
            <li><a href="index.html">PYQs</a><span class="sep">/</span></li>
            <li><span class="current">Not found</span></li>
        `;
    }

    async function loadPaper(id){
        loadingEl.style.display = 'grid';
        errorEl.style.display = 'none';
        contentEl.style.display = 'none';
        extraEl.style.display = 'none';
        relatedSectionEl.style.display = 'none';

        // Try cache first then server for speed
        let snap = null;
        try {
            snap = await db.collection('pyqs').doc(id).get({ source: 'cache' });
            if(!snap.exists){
                snap = await db.collection('pyqs').doc(id).get({ source: 'server' });
            } else {
                // refresh in background
                db.collection('pyqs').doc(id).get({ source: 'server' }).then(s=>{ if(s.exists) {/* silently updated */}}).catch(()=>{});
            }
        } catch(e){
            snap = await db.collection('pyqs').doc(id).get({ source: 'server' });
        }

        if(!snap || !snap.exists){
            showError('Paper not found', 'The paper with ID "'+escapeHtml(id)+'" does not exist. It may have been deleted or the link is incorrect.');
            return;
        }
        const data = { id: snap.id, ...snap.data() };
        currentPaper = normalizePaper(data);
        renderPaper(currentPaper);
        // increment views
        incrementViews(currentPaper.id);
        // load related and comments
        loadRelated(currentPaper);
        loadComments(currentPaper.id);
    }

    function normalizePaper(p){
        const views = Number(p.views);
        return {
            ...p,
            views: Number.isFinite(views) && views>=0 ? Math.floor(views) : 0
        };
    }

    function renderPaper(p){
        loadingEl.style.display = 'none';
        contentEl.style.display = 'block';
        extraEl.style.display = 'grid';

        const course = p.course || p.category || 'General';
        const semester = p.semester || p.sem || '';
        const session = p.session || '';
        const branch = p.branch || '';
        const title = p.title || (course + ' ' + semester + ' Paper');
        const views = typeof p.views === 'number' ? p.views : 0;
        const createdAt = p.createdAt || p.uploadedAt || p.addedAt || null;

        // SEO
        const pageTitle = title + ' | DSMNRU PYQ - ' + course + (semester ? ' ' + semester : '') + (session ? ' ('+session+')' : '');
        document.title = pageTitle;
        const metaDesc = 'Download '+title+' for '+course+(semester?' '+semester:'')+(session?' '+session:'')+'. Preview and download PDF, see views, share and find related papers on DSMNRU Archive.';
        document.querySelector('meta[name="description"]').setAttribute('content', metaDesc);
        const pageUrl = window.location.origin + window.location.pathname + '?id=' + encodeURIComponent(p.id);
        document.getElementById('canonicalLink').setAttribute('href', pageUrl);
        document.getElementById('ogTitle').setAttribute('content', title);
        document.getElementById('ogDescription').setAttribute('content', metaDesc);
        document.getElementById('ogUrl').setAttribute('content', pageUrl);
        document.getElementById('twitterTitle').setAttribute('content', title);
        document.getElementById('twitterDescription').setAttribute('content', metaDesc);
        const ld = {
            "@context": "https://schema.org",
            "@type": "Article",
            "headline": title,
            "description": metaDesc,
            "datePublished": createdAt ? (typeof createdAt.toDate==='function'?createdAt.toDate().toISOString(): String(createdAt)) : undefined,
            "author": {"@type":"Organization","name":"DSMNRU Academic Archive"},
            "publisher": {"@type":"Organization","name":"DSMNRU Academic Archive","logo":{"@type":"ImageObject","url":"https://dsmnru-pyq.netlify.app/img/Logo.png"}},
            "mainEntityOfPage": {"@type":"WebPage","@id": pageUrl}
        };
        document.getElementById('paperJsonLd').textContent = JSON.stringify(ld);

        // Breadcrumb
        const crumbCourse = escapeHtml(course);
        const crumbSem = escapeHtml(semester);
        breadcrumbEl.innerHTML = `
            <li><a href="index.html"><i class="fas fa-home"></i> Home</a><span class="sep">/</span></li>
            <li><a href="index.html">PYQs</a><span class="sep">/</span></li>
            ${course ? `<li><a href="index.html" onclick="sessionStorage.setItem('pendingCourse','${escapeJs(course)}');">${crumbCourse}</a><span class="sep">/</span></li>` : ''}
            ${semester ? `<li><a href="index.html">${crumbSem}</a><span class="sep">/</span></li>` : ''}
            <li><span class="current" title="${escapeHtml(title)}">${escapeHtml(title)}</span></li>
        `;

        // Kicker
        const kickerParts = ['PYQ', course];
        if(semester) kickerParts.push(semester);
        if(session) kickerParts.push(session);
        if(branch) kickerParts.push(branch);
        kickerEl.innerHTML = `<i class="fas fa-file-pdf"></i> <span>${escapeHtml(kickerParts.join(' • '))}</span>`;

        // Title
        titleEl.textContent = title;

        // Meta pills
        const pills = [];
        pills.push(`<span class="meta-pill views"><i class="fas fa-eye"></i> ${views} views</span>`);
        if(course) pills.push(`<span class="meta-pill"><i class="fas fa-graduation-cap"></i> ${escapeHtml(course)}</span>`);
        if(semester) pills.push(`<span class="meta-pill"><i class="fas fa-layer-group"></i> ${escapeHtml(semester)}</span>`);
        if(session) pills.push(`<span class="meta-pill session"><i class="fas fa-calendar"></i> ${escapeHtml(session)}</span>`);
        if(branch) pills.push(`<span class="meta-pill"><i class="fas fa-code-branch"></i> ${escapeHtml(branch)}</span>`);
        metaRowEl.innerHTML = pills.join('');

        submetaEl.innerHTML = `
            ${createdAt ? `<span><i class="fas fa-clock"></i> Added: ${escapeHtml(formatDate(createdAt))}</span>` : ''}
            <span style="margin-left:10px;"><i class="fas fa-link"></i> ID: <code style="background: rgba(255,255,255,0.08); padding:2px 6px; border-radius:6px;">${escapeHtml(p.id)}</code></span>
        `;

        // Actions
        const primary = getPrimaryLink(p);
        const secondary = getSecondaryLink(p);
        const primaryMeta = primary ? getPreviewMeta(primary) : null;
        const secondaryMeta = secondary ? getPreviewMeta(secondary) : null;
        const shareTarget = primary || secondary || pageUrl;

        const isBookmarked = checkBookmarked(shareTarget);

        let actionsHtml = '';
        if(primary){
            actionsHtml += `<button class="btn-paper btn-paper-primary" id="btnPreviewPrimary"><i class="${primaryMeta.icon}"></i> ${primaryMeta.label === 'Preview' ? 'Preview PDF' : 'Open PDF'}</button>`;
            actionsHtml += `<button class="btn-paper btn-paper-secondary" id="btnServer1"><i class="fas fa-download"></i> Server 1</button>`;
        }
        if(secondary){
            actionsHtml += `<button class="btn-paper btn-paper-secondary" id="btnServer2"><i class="${secondaryMeta.icon}"></i> Server 2</button>`;
        }
        actionsHtml += `<button class="btn-paper ${isBookmarked ? 'btn-paper-bookmarked' : 'btn-paper-secondary'}" id="btnBookmark"><i class="fas fa-bookmark"></i> ${isBookmarked ? 'Bookmarked' : 'Bookmark'}</button>`;
        actionsHtml += `<button class="btn-paper btn-paper-danger" id="btnReport"><i class="fas fa-triangle-exclamation"></i> Report Broken</button>`;
        actionsHtml += `<a href="index.html" class="btn-paper btn-paper-secondary"><i class="fas fa-arrow-left"></i> All Papers</a>`;

        actionsBarEl.innerHTML = actionsHtml;

        // Preview container
        if(primary && isDirectPdfUrl(primary) && !isMediaFireUrl(primary)){
            previewContainerEl.innerHTML = `
                <div class="paper-preview-frame">
                    <iframe src="${escapeHtml(primary)}" title="${escapeHtml(title)} preview" loading="lazy"></iframe>
                </div>
            `;
            previewHintEl.textContent = 'PDF loads inline — use full-screen preview for better reading';
            downloadAltEl.innerHTML = `<small style="color: rgba(203,213,225,0.6);">If preview fails (Drive/MediaFire), use Download buttons above.</small>`;
        } else if(primary){
            previewContainerEl.innerHTML = `
                <div class="paper-no-preview">
                    <i class="fas fa-file-pdf"></i>
                    <h4 style="color:#f8fafc; margin:8px 0;">Preview not available inline</h4>
                    <p style="margin:0 0 14px;">This paper is hosted externally. Click Server 1 or Server 2 above to load it here on the same site.</p>
                    <button class="btn-paper btn-paper-primary" style="justify-content:center;" id="btnFallbackPrimary"><i class="fas fa-eye"></i> Load Server 1 Preview Here</button>
                </div>
            `;
            previewHintEl.textContent = 'External link — opens in new tab';
        } else if(secondary) {
            // no primary but secondary exists
            if(isDirectPdfUrl(secondary) && !isMediaFireUrl(secondary)){
                previewContainerEl.innerHTML = `<div class="paper-preview-frame"><iframe src="${escapeHtml(secondary)}" title="${escapeHtml(title)} preview"></iframe></div>`;
            } else {
                previewContainerEl.innerHTML = `<div class="paper-no-preview"><i class="fas fa-link"></i><h4 style="color:#f8fafc;">Use Server 2</h4><button class="btn-paper btn-paper-primary" style="justify-content:center;" id="btnFallbackSecondary"><i class="fas fa-eye"></i> Load Server 2 Preview Here</button></div>`;
            }
        } else {
            previewContainerEl.innerHTML = `<div class="paper-no-preview"><i class="fas fa-bug"></i><h4 style="color:#f8fafc;">No file link available</h4><p>Admin has not added a file URL for this paper yet. Please report or request.</p></div>`;
            previewHintEl.textContent = 'No preview';
        }

        // Info list
        infoListEl.innerHTML = `
            <li><span>Course</span> <strong>${escapeHtml(course)}</strong></li>
            <li><span>Semester</span> <strong>${escapeHtml(semester || '-')}</strong></li>
            <li><span>Session</span> <strong>${escapeHtml(session || '-')}</strong></li>
            <li><span>Branch</span> <strong>${escapeHtml(branch || '-')}</strong></li>
            <li><span>Views</span> <strong id="infoViews">${views}</strong></li>
            <li><span>Document ID</span> <strong style="font-family: monospace; font-size: 12px;">${escapeHtml(p.id)}</strong></li>
        `;

        // Bind action handlers — all previews stay on same site
        const previewBtn = document.getElementById('btnPreviewPrimary');
        if(previewBtn && primary){
            previewBtn.addEventListener('click', () => openPreview(p.id, primary, title));
        }
        const s1Btn = document.getElementById('btnServer1');
        if(s1Btn && primary){
            s1Btn.addEventListener('click', () => loadPreviewOnSameSite(primary, title + ' — Server 1'));
        }
        const s2Btn = document.getElementById('btnServer2');
        if(s2Btn && secondary){
            s2Btn.addEventListener('click', () => loadPreviewOnSameSite(secondary, title + ' — Server 2'));
        }
        const fbPrimary = document.getElementById('btnFallbackPrimary');
        if(fbPrimary && primary){
            fbPrimary.addEventListener('click', () => loadPreviewOnSameSite(primary, title + ' — Server 1'));
        }
        const fbSecondary = document.getElementById('btnFallbackSecondary');
        if(fbSecondary && secondary){
            fbSecondary.addEventListener('click', () => loadPreviewOnSameSite(secondary, title + ' — Server 2'));
        }
        const _shareTopBtn = document.getElementById('btnShare');
        if (_shareTopBtn) _shareTopBtn.addEventListener('click', () => openShare(shareTarget, title));
        document.getElementById('btnBookmark').addEventListener('click', function(){
            const toggled = toggleBookmark(shareTarget);
            this.classList.toggle('btn-paper-bookmarked', toggled);
            this.innerHTML = `<i class="fas fa-bookmark"></i> ${toggled ? 'Bookmarked' : 'Bookmark'}`;
        });
        document.getElementById('btnReport').addEventListener('click', () => openReportModal(p));

        // Share buttons
        document.getElementById('paperCopyLinkBtn').addEventListener('click', () => copyCurrentLink(pageUrl));
        document.getElementById('shareWhatsappBtn').addEventListener('click', () => {
            window.open('https://wa.me/?text=' + encodeURIComponent(title + ' ' + pageUrl), '_blank');
        });
        document.getElementById('shareTelegramBtn').addEventListener('click', () => {
            window.open('https://t.me/share/url?url=' + encodeURIComponent(pageUrl) + '&text=' + encodeURIComponent(title), '_blank');
        });
        const nativeBtn = document.getElementById('shareNativeBtn');
        if(navigator.share){
            nativeBtn.style.display = 'inline-flex';
            nativeBtn.addEventListener('click', async () => {
                try { await navigator.share({ title: title, text: title, url: pageUrl }); } catch(e){}
            });
        }
        document.getElementById('paperReportInlineLink').addEventListener('click', (e)=>{ e.preventDefault(); openReportModal(p); });

        // Also wire copy link inside info card to show feedback
        updatePaperLockUI();
    }

    function openPreview(id, url, title){
        if (!currentUser) { if (typeof openSearchGateModal === 'function') openSearchGateModal(); else openLoginModal(); return; }
        if (requiresEmailVerificationPaper(currentUser)) { showPaperVerificationBlock(); return; }
        // Always stay on same site: try modal for direct PDFs, else inline preview (never window.open)
        if(isDirectPdfUrl(url) && !isMediaFireUrl(url)){
            const modalEl = document.getElementById('pdfModal');
            const viewer = document.getElementById('pdfViewer');
            document.getElementById('pdfModalLabel').textContent = title || 'Document Preview';
            viewer.src = url;
            const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
            modal.show();
            modalEl.addEventListener('hidden.bs.modal', function handler(){
                viewer.src = '';
                modalEl.removeEventListener('hidden.bs.modal', handler);
            });
        } else {
            // For Drive/Archive/catbox details pages, load in same-site inline preview
            loadPreviewOnSameSite(url, title);
            return;
        }
        incrementViews(id); // count preview as view (for modal case)
    }

    function handleDownloadClick(id){
        if (!currentUser) { if (typeof openSearchGateModal === 'function') openSearchGateModal(); else openLoginModal(); return; }
        if (requiresEmailVerificationPaper(currentUser)) { showPaperVerificationBlock(); return; }
        incrementViews(id);
    }
    window.handleDownloadClick = handleDownloadClick;

    function openShare(url, title){
        const shareLinkInput = document.getElementById('shareLink');
        const modalEl = document.getElementById('shareModal');
        shareLinkInput.value = url || window.location.href;
        const shareText = 'Check out this ' + (title || 'paper') + ' from DSMNRU Academic Archive';
        document.getElementById('whatsappShare').href = 'https://wa.me/?text=' + encodeURIComponent(shareText + ' ' + shareLinkInput.value);
        document.getElementById('telegramShare').href = 'https://t.me/share/url?url=' + encodeURIComponent(shareLinkInput.value) + '&text=' + encodeURIComponent(shareText);
        document.getElementById('emailShare').href = 'mailto:?subject=' + encodeURIComponent(title || 'DSMNRU Paper') + '&body=' + encodeURIComponent(shareText + '\n\n' + shareLinkInput.value);
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        modal.show();
    }

    function copyCurrentLink(url){
        const text = url || window.location.href;
        if(navigator.clipboard && window.isSecureContext){
            navigator.clipboard.writeText(text).then(()=>{
                Swal.fire({ icon:'success', title:'Link copied!', text: text, timer: 2200, showConfirmButton:false });
            });
        } else {
            // fallback via share modal
            openShare(text, currentPaper ? currentPaper.title : 'DSMNRU Paper');
            setTimeout(()=>{
                const input = document.getElementById('shareLink');
                input.select(); input.setSelectionRange(0,99999);
                try { document.execCommand('copy'); Swal.fire('Copied!', 'Link copied to clipboard', 'success'); } catch(e){}
            }, 300);
        }
    }

    function openReportModal(p){
        const modalEl = document.getElementById('reportBrokenLinkModal');
        document.getElementById('reportTitle').value = p.title || '';
        document.getElementById('reportCourse').value = (p.course || '') + (p.semester ? ' ' + p.semester : '') + (p.session ? ' ' + p.session : '');
        document.getElementById('reportDetails').value = '';
        document.getElementById('reportEmail').value = currentUser ? currentUser.email : '';
        document.getElementById('reportBrokenLinkError').style.display='none';
        document.getElementById('reportBrokenLinkSuccess').style.display='none';
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        modal.show();
    }

    // Views
    function incrementViews(id){
        if(!id) return;
        try {
            db.collection('pyqs').doc(id).set({ views: firebase.firestore.FieldValue.increment(1)}, { merge:true }).catch(e=> console.warn('view inc failed', e.message));
            // optimistic UI
            if(currentPaper && currentPaper.id===id){
                currentPaper.views = (currentPaper.views||0)+1;
                const el = document.getElementById('infoViews');
                if(el) el.textContent = currentPaper.views;
                // update pills
                const pill = document.querySelector('.meta-pill.views');
                if(pill) pill.innerHTML = `<i class="fas fa-eye"></i> ${currentPaper.views} views`;
            }
        } catch(e){}
    }

    // Bookmarks - localStorage
    function getBookmarks(){
        try { const raw = localStorage.getItem('dsmnruBookmarks'); return raw ? JSON.parse(raw) : { pyqs: [] }; } catch(e){ return { pyqs: [] }; }
    }
    function checkBookmarked(target){
        if(!target) return false;
        const bm = getBookmarks();
        return Array.isArray(bm.pyqs) && bm.pyqs.includes(target);
    }
    function toggleBookmark(target){
        if(!target) return false;
        const bm = getBookmarks();
        if(!Array.isArray(bm.pyqs)) bm.pyqs = [];
        const idx = bm.pyqs.indexOf(target);
        let isNow = false;
        if(idx>-1){ bm.pyqs.splice(idx,1); isNow=false; }
        else { bm.pyqs.push(target); isNow=true; }
        localStorage.setItem('dsmnruBookmarks', JSON.stringify(bm));
        return isNow;
    }

    // Related papers — cache-first (0 reads if homepage already cached full list)
    async function loadRelated(p){
        relatedSectionEl.style.display = 'block';
        relatedGridEl.innerHTML = `<div class="skeleton-box" style="height:90px;"></div><div class="skeleton-box" style="height:90px;"></div><div class="skeleton-box" style="height:90px;"></div>`;
        relatedSubtitleEl.textContent = 'Fetching related papers...';
        try {
            // 0️⃣ Check session/local cache first — 0 reads
            const cachedFull = getCachedPyqsFullForPaper();
            if (cachedFull && Array.isArray(cachedFull) && cachedFull.length) {
                let items = cachedFull.filter(item => item.id !== p.id);
                // filter by course fuzzy
                if (p.course) {
                    const normCourse = String(p.course).toLowerCase().trim().replace(/[^a-z0-9]/g,'');
                    const filtered = items.filter(it => {
                        const c = String(it.course||it.category||'').toLowerCase().replace(/[^a-z0-9]/g,'');
                        const t = String(it.title||'').toLowerCase();
                        return c.includes(normCourse) || t.includes(normCourse);
                    });
                    if (filtered.length) items = filtered;
                }
                // prioritize same semester + sort by views
                if (p.semester) {
                    const semLow = String(p.semester).toLowerCase();
                    items.sort((a,b)=>{
                        const aSem = String(a.semester||'').toLowerCase() === semLow ? 0 : 1;
                        const bSem = String(b.semester||'').toLowerCase() === semLow ? 0 : 1;
                        if (aSem!==bSem) return aSem-bSem;
                        return (b.views||0)-(a.views||0);
                    });
                } else {
                    items.sort((a,b)=> (b.views||0)-(a.views||0));
                }
                items = items.slice(0,6);
                if (items.length) {
                    relatedSubtitleEl.textContent = `More from ${escapeHtml(p.course || 'this course')}${p.semester ? ' • '+escapeHtml(p.semester):''} — ${items.length} papers (from cache, 0 reads)`;
                    relatedGridEl.innerHTML = items.map(item=>{
                        const href = `paper.html?id=${encodeURIComponent(item.id)}`;
                        const sem = item.semester ? `<span><i class="fas fa-layer-group"></i> ${escapeHtml(item.semester)}</span>` : '';
                        const sess = item.session ? `<span><i class="fas fa-calendar"></i> ${escapeHtml(item.session)}</span>` : '';
                        const views = item.views ? `<span><i class="fas fa-eye"></i> ${item.views}</span>` : '';
                        return `<a class="related-card" href="${href}"><h4>${escapeHtml(item.title || 'Untitled paper')}</h4><p>${escapeHtml(item.course || '')} ${escapeHtml(item.semester||'')} ${escapeHtml(item.session||'')}</p><div class="related-meta">${views} ${sem} ${sess}</div></a>`;
                    }).join('');
                    return;
                }
                // if cache existed but no related found, fall through to server
            }

            let q = null;
            if(p.course){
                q = db.collection('pyqs').where('course','==', p.course).limit(12);
            } else {
                q = db.collection('pyqs').orderBy('title').limit(12);
            }
            let snap;
            try { snap = await q.get({ source:'server' }); } catch(e){ snap = await db.collection('pyqs').limit(18).get(); }
            let items = snap.docs.map(d=> ({ id:d.id, ...d.data()} )).filter(item=> item.id !== p.id);
            if(items.length===0 && p.course){
                const allSnap = await db.collection('pyqs').limit(30).get();
                const all = allSnap.docs.map(d=>({id:d.id,...d.data()}));
                const normCourse = String(p.course).toLowerCase().trim();
                items = all.filter(it=>{
                    const c = String(it.course||'').toLowerCase().trim();
                    const t = String(it.title||'').toLowerCase();
                    return (c.includes(normCourse) || t.includes(normCourse)) && it.id !== p.id;
                }).slice(0,12);
            }
            // prioritize same semester
            if(p.semester){
                const semLow = String(p.semester).toLowerCase();
                items.sort((a,b)=>{
                    const aSem = String(a.semester||'').toLowerCase() === semLow ? 0 : 1;
                    const bSem = String(b.semester||'').toLowerCase() === semLow ? 0 : 1;
                    if(aSem!==bSem) return aSem-bSem;
                    return (b.views||0)-(a.views||0);
                });
            } else {
                items.sort((a,b)=> (b.views||0)-(a.views||0));
            }
            items = items.slice(0,6);
            if(items.length===0){
                relatedGridEl.innerHTML = `<div class="comment-empty" style="grid-column:1/-1;"><i class="fas fa-folder-open"></i> No related papers found for this course yet.<br><a href="index.html" style="color:#9cecf3; font-weight:700;">Browse all papers</a></div>`;
                relatedSubtitleEl.textContent = 'No related papers yet';
                return;
            }
            relatedSubtitleEl.textContent = `More from ${escapeHtml(p.course || 'this course')}${p.semester ? ' • '+escapeHtml(p.semester):''} — ${items.length} papers`;
            relatedGridEl.innerHTML = items.map(item=>{
                const link = getPrimaryLink(item) || getSecondaryLink(item);
                const href = `paper.html?id=${encodeURIComponent(item.id)}`;
                const sem = item.semester ? `<span><i class="fas fa-layer-group"></i> ${escapeHtml(item.semester)}</span>` : '';
                const sess = item.session ? `<span><i class="fas fa-calendar"></i> ${escapeHtml(item.session)}</span>` : '';
                const views = item.views ? `<span><i class="fas fa-eye"></i> ${item.views}</span>` : '';
                return `
                    <a class="related-card" href="${href}">
                        <h4>${escapeHtml(item.title || 'Untitled paper')}</h4>
                        <p>${escapeHtml(item.course || '')} ${escapeHtml(item.semester||'')} ${escapeHtml(item.session||'')}</p>
                        <div class="related-meta">${views} ${sem} ${sess}</div>
                    </a>
                `;
            }).join('');

        } catch(e){
            console.warn('related load failed', e);
            relatedGridEl.innerHTML = `<div class="comment-empty" style="grid-column:1/-1;">Unable to load related papers right now.</div>`;
        }
    }

    // Comments - Firestore collection: 'comments' with paperId field, or subcollection 'pyqs/{id}/comments'
    // We'll use top-level 'comments' for simplicity, also check subcollection fallback
    async function loadComments(paperId){
        commentListEl.innerHTML = `<div class="comment-empty"><i class="fas fa-spinner fa-spin"></i> Loading comments...</div>`;
        try {
            // Try top-level collection first
            let snap = null;
            try {
                snap = await db.collection('comments').where('paperId','==', paperId).orderBy('createdAt','desc').limit(30).get();
                if(snap.empty){
                    // also try subcollection
                    const subSnap = await db.collection('pyqs').doc(paperId).collection('comments').orderBy('createdAt','desc').limit(30).get();
                    if(!subSnap.empty){
                        snap = subSnap; // use subcollection
                        // mark type
                        snap._isSub = true;
                    }
                }
            } catch(e){
                // if orderBy fails due to missing index, fallback to unordered
                try { snap = await db.collection('comments').where('paperId','==', paperId).limit(30).get(); } catch(err2){ snap = null; }
                if(!snap || snap.empty){
                    try { snap = await db.collection('pyqs').doc(paperId).collection('comments').limit(30).get(); } catch(err3){}
                }
            }
            if(!snap || snap.empty){
                commentListEl.innerHTML = `<div class="comment-empty"><i class="fas fa-comments"></i> No comments yet. Be the first to share your thoughts!<br><small>This discussion is moderated. Be respectful.</small></div>`;
                return;
            }
            const comments = snap.docs.map(d=> ({ id:d.id, ...d.data()}));
            // sort by createdAt desc if not already
            comments.sort((a,b)=>{
                const ta = a.createdAt && typeof a.createdAt.toDate==='function' ? a.createdAt.toDate().getTime() : (a.createdAt? new Date(a.createdAt).getTime():0);
                const tb = b.createdAt && typeof b.createdAt.toDate==='function' ? b.createdAt.toDate().getTime() : (b.createdAt? new Date(b.createdAt).getTime():0);
                return tb-ta;
            });
            commentListEl.innerHTML = comments.map(c=>{
                const name = c.userName || c.author || (c.userEmail ? c.userEmail.split('@')[0] : 'Anonymous');
                const initials = String(name).trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase().slice(0,2) || 'A';
                const time = formatDate(c.createdAt);
                const text = escapeHtml(c.text || c.comment || c.message || '');
                return `
                    <div class="comment-item">
                        <div class="comment-head">
                            <div class="comment-avatar">${escapeHtml(initials)}</div>
                            <div>
                                <div class="comment-author">${escapeHtml(name)}</div>
                                <div class="comment-time">${escapeHtml(time)}</div>
                            </div>
                        </div>
                        <div class="comment-text">${text}</div>
                    </div>
                `;
            }).join('');
        } catch(e){
            console.error('comments load failed', e);
            commentListEl.innerHTML = `<div class="comment-empty">Unable to load comments right now. Please refresh.</div>`;
        }
    }

    // Comment form
    if(commentForm){
        commentText.addEventListener('input', ()=>{ commentCharCount.textContent = commentText.value.length; });
        commentForm.addEventListener('submit', async (e)=>{
            e.preventDefault();
            const text = commentText.value.trim();
            if(!text){ commentErrorEl.textContent='Please write a comment.'; commentErrorEl.style.display='block'; return; }
            if(text.length<3){ commentErrorEl.textContent='Comment too short.'; commentErrorEl.style.display='block'; return; }
            if (requiresEmailVerificationPaper(currentUser)) { showPaperVerificationBlock(); return; }
            if(!currentUser){
                // prompt login
                commentErrorEl.style.display='none';
                Swal.fire({
                    title: 'Login required',
                    text: 'You need to login to post a comment.',
                    icon: 'info',
                    showCancelButton: true,
                    confirmButtonText: 'Login now'
                }).then(res=>{
                    if(res.isConfirmed) openLoginModal();
                });
                return;
            }
            commentErrorEl.style.display='none';
            commentSuccessEl.style.display='none';
            const btn = commentForm.querySelector('button[type="submit"]');
            const oldHtml = btn.innerHTML;
            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Posting...';
            try {
                const payload = {
                    paperId: currentPaperId,
                    text: text,
                    userId: currentUser.uid,
                    userName: currentUser.displayName || currentUser.email.split('@')[0] || 'User',
                    userEmail: currentUser.email || '',
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                };
                // try top-level first
                let wrote = false;
                try {
                    await db.collection('comments').add(payload);
                    wrote = true;
                } catch(err){
                    // fallback to subcollection
                    await db.collection('pyqs').doc(currentPaperId).collection('comments').add(payload);
                    wrote = true;
                }
                commentText.value = '';
                commentCharCount.textContent = '0';
                commentSuccessEl.textContent = 'Comment posted! Thank you for contributing.';
                commentSuccessEl.style.display='block';
                setTimeout(()=> commentSuccessEl.style.display='none', 2500);
                // reload comments
                await loadComments(currentPaperId);
                // update related? no
            } catch(err){
                commentErrorEl.textContent = err.message || 'Failed to post comment.';
                commentErrorEl.style.display='block';
            } finally {
                btn.disabled=false; btn.innerHTML=oldHtml;
            }
        });
    }

    // Copy link delegation for share modal
    const copyLinkBtn = document.getElementById('copyLinkBtn');
    if(copyLinkBtn){
        copyLinkBtn.addEventListener('click', ()=>{
            const input = document.getElementById('shareLink');
            input.select(); input.setSelectionRange(0,99999);
            let copied=false;
            try { copied = document.execCommand('copy'); } catch(e){}
            if(copied || navigator.clipboard){
                if(navigator.clipboard && window.isSecureContext){
                    navigator.clipboard.writeText(input.value).catch(()=>{});
                }
                const old = copyLinkBtn.innerHTML;
                copyLinkBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
                setTimeout(()=> copyLinkBtn.innerHTML=old, 1800);
            }
        });
    }

    // Ensure pdf modal cleanup
    document.addEventListener('hidden.bs.modal', (e)=>{
        if(e.target && e.target.id==='pdfModal'){
            const v = document.getElementById('pdfViewer');
            if(v) v.src='';
        }
    });

    // Start
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // Expose for inline handlers (handleDownloadClick already)
})();
