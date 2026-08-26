/**
 * DSMNRU PYQ — duplicate-detection assistance (admin only).
 *
 * This is NOT an automatic duplicate detector and it never changes a
 * submission's status. It ranks existing PYQs against a new submission so the
 * admin can eyeball the closest matches and decide:
 *   same paper  → Reject  (0 points)
 *   different   → Approve (+10 points)
 *
 * Matching signals (nothing else is used):
 *   title     REQUIRED — the primary and strongest signal
 *   course    OPTIONAL — confidence booster/penalty ONLY when both records have it
 *   semester  OPTIONAL — confidence booster/penalty ONLY when both records have it
 * There is no year field and year is never considered.
 *
 * A missing optional field is NOT a mismatch: it is simply not used as a
 * signal for that comparison, and a candidate is never excluded because a
 * course or semester differs (or is absent).
 *
 * Implementation is deliberately lightweight — normalized token overlap plus a
 * Levenshtein fallback for typos/word-order. No AI, no LLM, no OCR, no
 * embeddings, no external APIs.
 */
(function (global) {
    'use strict';

    // ── Normalization ────────────────────────────────────────────────
    // Noise words that carry no identity: "Previous Year Question Paper",
    // "Final Exam", the site name, etc. Semester words are dropped too —
    // semester is scored as its own field.
    const STOP_WORDS = new Set([
        'of', 'the', 'and', 'for', 'in', 'on', 'a', 'an',
        'paper', 'papers', 'question', 'questions', 'previous', 'year', 'years',
        'pyq', 'pyqs', 'exam', 'examination', 'final', 'mid', 'term', 'test',
        'semester', 'sem', 'session', 'dsmnru', 'subject'
    ]);

    // Common academic abbreviations expanded on BOTH sides, so "DBMS" and
    // "Database Management System" normalize to the same token set. Kept short
    // and explicit on purpose — this is a hint list, not a dictionary.
    const ABBREVIATIONS = {
        dbms: 'database management system',
        rdbms: 'relational database management system',
        os: 'operating system',
        cn: 'computer network',
        cns: 'computer network security',
        dsa: 'data structures and algorithms',
        ds: 'data structures',
        daa: 'design and analysis algorithms',
        toc: 'theory of computation',
        coa: 'computer organization architecture',
        ca: 'computer architecture',
        se: 'software engineering',
        ai: 'artificial intelligence',
        ml: 'machine learning',
        dl: 'deep learning',
        dld: 'digital logic design',
        dmc: 'digital media communication',
        em: 'engineering mathematics',
        ems: 'engineering mathematics',
        be: 'basic electronics',
        bEEE: 'basic electrical electronics engineering',
        ee: 'electrical engineering',
        phy: 'physics',
        chem: 'chemistry',
        eco: 'economics',
        econ: 'economics',
        maths: 'mathematics',
        math: 'mathematics',
        stat: 'statistics',
        stats: 'statistics',
        prob: 'probability',
        eng: 'engineering',
        mgmt: 'management',
        mgt: 'management',
        acct: 'accounting',
        acc: 'accounting',
        fin: 'finance',
        hr: 'human resource',
        hrm: 'human resource management',
        om: 'operations management',
        cs: 'computer science',
        it: 'information technology',
        bba: 'bachelor business administration',
        bca: 'bachelor computer application',
        mba: 'master business administration',
        mca: 'master computer application'
    };

    /**
     * Normalize free text for comparison:
     * lowercase → trim → collapse whitespace → drop punctuation → strip the
     * `{2024-25}` style session/year suffix the PYQ titles carry.
     */
    function normalizeText(raw) {
        if (raw === null || raw === undefined) return '';
        return String(raw)
            .toLowerCase()
            .replace(/\{[^}]*\}/g, ' ')          // {2024-25}, {2023} session suffixes
            .replace(/&/g, ' and ')
            .replace(/([a-z0-9])\.(?=[a-z0-9])/g, '$1')  // "b.a." / "b.tech" stay one token
            .replace(/[-_/\\|]+/g, ' ')          // hyphens/underscores separate words
            .replace(/[^a-z0-9 ]+/g, ' ')        // drop remaining punctuation
            .replace(/\s+/g, ' ')                // collapse whitespace
            .trim();
    }

    /** Light singularization so "structures" matches "structure". */
    function singularize(token) {
        if (token.length > 3 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
        if (token.length > 4 && /(ses|xes|zes|ches|shes)$/.test(token)) return token.slice(0, -2);
        if (token.length > 3 && token.endsWith('s') && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
        return token;
    }

    /** Normalized token set: stop words removed, abbreviations expanded. */
    function tokenize(raw) {
        const words = normalizeText(raw).split(' ').filter(Boolean);
        const tokens = [];
        words.forEach((word) => {
            if (STOP_WORDS.has(word)) return;
            const expansion = ABBREVIATIONS[word];
            if (expansion) {
                expansion.split(' ').forEach((part) => {
                    if (!STOP_WORDS.has(part)) tokens.push(singularize(part));
                });
                return;
            }
            tokens.push(singularize(word));
        });
        return tokens;
    }

    // ── Similarity primitives ────────────────────────────────────────
    function toSet(tokens) {
        return new Set(tokens);
    }

    function intersectionSize(a, b) {
        let n = 0;
        a.forEach((value) => { if (b.has(value)) n += 1; });
        return n;
    }

    /** Sørensen–Dice on token sets. */
    function diceCoefficient(setA, setB) {
        if (!setA.size || !setB.size) return 0;
        return (2 * intersectionSize(setA, setB)) / (setA.size + setB.size);
    }

    /** Overlap coefficient — handles "X" vs "X Lab" style subset titles. */
    function containmentCoefficient(setA, setB) {
        if (!setA.size || !setB.size) return 0;
        return intersectionSize(setA, setB) / Math.min(setA.size, setB.size);
    }

    /** Classic Levenshtein distance (iterative, O(n*m) — titles are short). */
    function levenshteinDistance(a, b) {
        if (a === b) return 0;
        if (!a.length) return b.length;
        if (!b.length) return a.length;
        let previous = new Array(b.length + 1);
        let current = new Array(b.length + 1);
        for (let j = 0; j <= b.length; j += 1) previous[j] = j;
        for (let i = 1; i <= a.length; i += 1) {
            current[0] = i;
            for (let j = 1; j <= b.length; j += 1) {
                const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
                current[j] = Math.min(
                    current[j - 1] + 1,
                    previous[j] + 1,
                    previous[j - 1] + cost
                );
            }
            const swap = previous; previous = current; current = swap;
        }
        return previous[b.length];
    }

    /**
     * Title similarity in [0, 1]. Token overlap is the primary measure; the
     * normalized-string Levenshtein ratio is a fallback that catches typos and
     * word-order differences (only used for strings long enough to be
     * meaningful). The stronger of the two wins, so a title alone can reach 1.
     */
    function titleSimilarity(titleA, titleB) {
        const normA = normalizeText(titleA);
        const normB = normalizeText(titleB);
        if (!normA || !normB) return 0;
        if (normA === normB) return 1;

        const setA = toSet(tokenize(titleA));
        const setB = toSet(tokenize(titleB));
        const tokenScore = Math.max(
            diceCoefficient(setA, setB),
            containmentCoefficient(setA, setB) * 0.85
        );

        let charScore = 0;
        if (normA.length >= 6 && normB.length >= 6) {
            const longest = Math.max(normA.length, normB.length);
            charScore = 1 - levenshteinDistance(normA, normB) / longest;
        }

        return Math.max(tokenScore, charScore);
    }

    /**
     * True when the two titles are identical after normalization. This is a
     * certainty on the primary signal, so it is scored at 1.0 regardless of
     * any missing optional field (an empty course/semester must never hide an
     * exact title match).
     */
    function isExactTitle(titleA, titleB) {
        const normA = normalizeText(titleA);
        const normB = normalizeText(titleB);
        return !!normA && normA === normB;
    }

    /** Course comparison: "B.Tech" vs "B.Tech CSE" counts as similar. */
    function courseSimilarity(courseA, courseB) {
        const setA = toSet(tokenize(courseA));
        const setB = toSet(tokenize(courseB));
        return Math.max(
            diceCoefficient(setA, setB),
            containmentCoefficient(setA, setB)
        );
    }

    function semesterKey(semester) {
        return normalizeText(semester).replace(/[^a-z0-9]/g, '');
    }

    function hasText(value) {
        return value !== null && value !== undefined && String(value).trim() !== '';
    }

    function clamp01(value) {
        return Math.max(0, Math.min(1, value));
    }

    // Confidence weights. Title always dominates (on its own it carries
    // TITLE_WEIGHT of the score); the optional fields only nudge the result,
    // and only when both records actually carry them.
    const TITLE_WEIGHT = 0.9;
    const COURSE_MATCH_BONUS = 0.12;
    const COURSE_DIFFERENT_PENALTY = 0.18;
    const SEMESTER_MATCH_BONUS = 0.08;
    const SEMESTER_DIFFERENT_PENALTY = 0.12;
    const COURSE_SIMILAR_THRESHOLD = 0.6;

    /**
     * Score one existing PYQ against a submission.
     * Returns { confidence, titleScore, course, semester } where `course` and
     * `semester` are 'match' | 'different' | 'unknown' (unknown = not usable as
     * a signal because one side is missing the field).
     */
    function scoreCandidate(submission, existing) {
        const exactTitle = isExactTitle(
            submission && submission.title,
            existing && existing.title
        );
        const titleScore = exactTitle
            ? 1
            : titleSimilarity(submission && submission.title, existing && existing.title);
        // An exact title match starts at maximum confidence; optional fields can
        // still adjust it, but they can never cancel the match.
        let confidence = exactTitle ? 1 : TITLE_WEIGHT * titleScore;

        let bonus = 0;
        let penalty = 0;

        let course = 'unknown';
        if (hasText(submission && submission.course) && hasText(existing && existing.course)) {
            if (courseSimilarity(submission.course, existing.course) >= COURSE_SIMILAR_THRESHOLD) {
                course = 'match';
                bonus += COURSE_MATCH_BONUS;
            } else {
                course = 'different';
                penalty += COURSE_DIFFERENT_PENALTY;
            }
        }

        let semester = 'unknown';
        if (hasText(submission && submission.semester) && hasText(existing && existing.semester)) {
            if (semesterKey(submission.semester) === semesterKey(existing.semester)) {
                semester = 'match';
                bonus += SEMESTER_MATCH_BONUS;
            } else {
                semester = 'different';
                penalty += SEMESTER_DIFFERENT_PENALTY;
            }
        }

        // Bonuses are capped at 1 first; penalties are then subtracted, so a
        // differing optional field always lowers the score (a course match can
        // never cancel out a semester mismatch).
        confidence = Math.max(0, clamp01(confidence + bonus) - penalty);

        return {
            confidence: clamp01(confidence),
            titleScore: titleScore,
            exactTitle: exactTitle,
            course: course,
            semester: semester
        };
    }

    /**
     * Rank existing PYQs against a submission.
     *
     * Candidates are NEVER excluded because course/semester differ or are
     * missing — the only filters are the title-driven minimum confidence and
     * the result limit, and the list is only ever shown to the admin.
     *
     * @returns [{ pyq, confidence, titleScore, course, semester }] sorted by
     *          confidence descending.
     */
    function findCandidates(submission, existingPyqs, options) {
        const opts = options || {};
        const limit = Number.isFinite(opts.limit) ? opts.limit : 5;
        const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : 0.35;

        if (!submission || !hasText(submission.title)) return [];
        if (!Array.isArray(existingPyqs) || !existingPyqs.length) return [];

        return existingPyqs
            .map((pyq) => {
                const score = scoreCandidate(submission, pyq);
                return {
                    pyq: pyq,
                    confidence: score.confidence,
                    titleScore: score.titleScore,
                    exactTitle: score.exactTitle,
                    course: score.course,
                    semester: score.semester
                };
            })
            // An exact title match is never filtered out, whatever the floor is.
            .filter((entry) => entry.exactTitle || entry.confidence >= minConfidence)
            // Exact titles first, then confidence, then raw title similarity.
            .sort((a, b) => (b.exactTitle === a.exactTitle
                ? 0
                : (b.exactTitle ? 1 : -1))
                || (b.confidence - a.confidence)
                || (b.titleScore - a.titleScore))
            .slice(0, limit);
    }

    function confidenceLabel(confidence) {
        if (confidence >= 0.75) return 'Very likely the same paper';
        if (confidence >= 0.55) return 'Likely similar';
        return 'Possibly related';
    }

    global.DSMNRUDuplicates = {
        STOP_WORDS: STOP_WORDS,
        ABBREVIATIONS: ABBREVIATIONS,
        normalizeText: normalizeText,
        tokenize: tokenize,
        diceCoefficient: diceCoefficient,
        containmentCoefficient: containmentCoefficient,
        levenshteinDistance: levenshteinDistance,
        titleSimilarity: titleSimilarity,
        isExactTitle: isExactTitle,
        courseSimilarity: courseSimilarity,
        scoreCandidate: scoreCandidate,
        findCandidates: findCandidates,
        confidenceLabel: confidenceLabel,
        hasText: hasText
    };
})(typeof window !== 'undefined' ? window : globalThis);
