/**
 * DSMNRU PYQ — Contribution Points (shared helpers).
 *
 * Loaded by the public pages (index.html / contributors.html / tools.html via
 * script.js) AND by admin.html (admin.js) so that the email normalization and
 * the reward constants are defined in exactly ONE place. Never duplicate this
 * logic in a page script: a reward identity must resolve to the same account
 * no matter which page created it.
 *
 * Rules:
 *  - Email is the reward identity (uploaders do not need an account).
 *  - Normalization = trim + lowercase, nothing else.
 *    "Rahul@gmail.com", "rahul@gmail.com", " RAHUL@GMAIL.COM " → "rahul@gmail.com"
 *  - The reward account document id is derived deterministically from the
 *    normalized email (Firestore ids cannot contain "/").
 *  - A PYQ contribution reward is always 10 points and is always written to
 *    the `point_transactions` ledger with the submission id as its key, which
 *    makes a second reward for the same submission impossible.
 *
 * This file contains no secrets and no network calls.
 */
(function (global) {
    'use strict';

    // Points awarded for ONE approved PYQ contribution. Never read from the client.
    const PYQ_UPLOAD_REWARD_POINTS = 10;
    const PYQ_UPLOAD_REWARD_TYPE = 'PYQ_UPLOAD_REWARD';

    const SUBMISSION_STATUS = {
        PENDING: 'pending',
        APPROVED: 'approved',
        REJECTED: 'rejected'
    };

    /**
     * Normalize a reward email: trim surrounding whitespace + lowercase.
     * Returns '' for anything that is not a string-like value.
     */
    function normalizeRewardEmail(raw) {
        if (raw === null || raw === undefined) return '';
        return String(raw).trim().toLowerCase();
    }

    /**
     * Basic shape check for a reward email (no verification performed).
     */
    function isValidRewardEmail(raw) {
        const email = normalizeRewardEmail(raw);
        if (!email || email.length > 160) return false;
        return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
    }

    /**
     * Deterministic, filesystem-safe Firestore document id for a reward email.
     * "rahul@gmail.com" → "rahul_gmail_com"
     */
    function rewardAccountKey(raw) {
        const email = normalizeRewardEmail(raw);
        if (!email) return '';
        return email.replace(/[^a-z0-9]/g, '_');
    }

    /**
     * Normalize a stored submission status. Anything unknown/missing counts as
     * pending (legacy documents written before the points feature).
     */
    function submissionStatus(raw) {
        const status = normalizeRewardEmail(raw);
        if (status === SUBMISSION_STATUS.APPROVED || status === SUBMISSION_STATUS.REJECTED) {
            return status;
        }
        return SUBMISSION_STATUS.PENDING;
    }

    /**
     * The email a submission's points belong to. Accepts both the legacy
     * `studentEmail` field and the `email` alias.
     */
    function submissionEmail(submission) {
        if (!submission) return '';
        return normalizeRewardEmail(submission.studentEmail || submission.email);
    }

    global.DSMNRUPoints = {
        PYQ_UPLOAD_REWARD_POINTS: PYQ_UPLOAD_REWARD_POINTS,
        PYQ_UPLOAD_REWARD_TYPE: PYQ_UPLOAD_REWARD_TYPE,
        SUBMISSION_STATUS: SUBMISSION_STATUS,
        normalizeRewardEmail: normalizeRewardEmail,
        isValidRewardEmail: isValidRewardEmail,
        rewardAccountKey: rewardAccountKey,
        submissionStatus: submissionStatus,
        submissionEmail: submissionEmail
    };
})(typeof window !== 'undefined' ? window : globalThis);
