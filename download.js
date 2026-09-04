/**
 * DSMNRU PYQ — download page logic.
 *
 * Tiny, dependency-free script. It only:
 *  1. reads the centralized APK config (apk-config.js),
 *  2. enables the Download CTA when a real release URL is configured,
 *  3. keeps the page honest when no release asset exists yet,
 *  4. emits a click event for future analytics (no analytics is loaded on
 *     this site today — see README "No Analytics").
 *
 * No Firebase, no frameworks, no blocking scripts.
 */
(function () {
    'use strict';

    var config = (typeof window.DSMNRU_APK === 'object' && window.DSMNRU_APK) || {};
    var releaseUrl = String(config.releaseUrl || '').trim();
    var versionName = String(config.versionName || '').trim();
    var versionCode = String(config.versionCode || '').trim();
    var minAndroid = String(config.minAndroid || '').trim();
    var fileSize = config.fileSize ? String(config.fileSize) : '';
    var releasedAt = config.releasedAt ? String(config.releasedAt) : '';

    // ── Static metadata fields ─────────────────────────────────────────
    function setText(id, value) {
        var el = document.getElementById(id);
        if (!el) return;
        el.textContent = value;
    }
    function setDate(id, value) {
        var el = document.getElementById(id);
        if (!el) return;
        if (value) {
            el.textContent = value;
            el.closest('.apk-fact') && el.closest('.apk-fact').classList.remove('is-unknown');
        } else {
            el.textContent = 'Not published yet';
            el.closest('.apk-fact') && el.closest('.apk-fact').classList.add('is-unknown');
        }
    }

    if (versionName) setText('apkVersionName', versionName);
    if (versionCode) setText('apkVersionCode', 'Build ' + versionCode);
    if (minAndroid) setText('apkMinAndroid', minAndroid);
    setText('apkFileSize', fileSize || 'Not published yet');
    setDate('apkReleasedAt', releasedAt);

    // ── Download CTA ─────────────────────────────────────────────────--
    var cta = document.getElementById('downloadApkBtn');
    if (cta) {
        if (releaseUrl) {
            cta.href = releaseUrl;
            cta.removeAttribute('aria-disabled');
            cta.classList.remove('is-pending');
            cta.querySelector('.cta-label') && (cta.querySelector('.cta-label').textContent = 'Download APK');
            cta.addEventListener('click', function (event) {
                // Never claim the app was installed by this click. The event
                // is a hook for analytics tooling only (none loaded today).
                try {
                    document.dispatchEvent(new CustomEvent('dsmnru:apk_download_click', {
                        detail: { version: versionName, versionCode: versionCode }
                    }));
                    if (typeof window.__apkDownloadClick === 'function') {
                        window.__apkDownloadClick({ version: versionName, versionCode: versionCode });
                    }
                    console.debug('[dsmnru] apk_download_click', versionName || '');
                } catch (e) { /* analytics must never break the download */ }
            });
        } else {
            cta.setAttribute('aria-disabled', 'true');
            cta.classList.add('is-pending');
            cta.setAttribute('href', '#apk-setup-note');
            cta.addEventListener('click', function (event) {
                event.preventDefault();
                var note = document.getElementById('apk-setup-note');
                if (note) {
                    note.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    note.focus({ preventScroll: true });
                }
            });
            var pending = document.getElementById('apkPendingNote');
            if (pending) pending.hidden = false;
        }
    }

    // ── Version/last-update facts ──────────────────────────────────────
    var releaseNotes = document.getElementById('apkReleaseNotes');
    var notesUrl = String(config.releaseNotesUrl || '').trim();
    if (releaseNotes && notesUrl) {
        releaseNotes.href = notesUrl;
        releaseNotes.hidden = false;
    }
})();
