/**
 * DSMNRU PYQ Android — curated link dataset for the in-app Links screen.
 *
 * Verbatim categories from the website's Links page (links.html) so both
 * surfaces show the same destinations — the data is static, so it ships with
 * the app: ZERO network requests, no new Worker endpoint, no duplication of
 * any backend. Every URL is a genuinely external university/government
 * portal — none points at the DSMNRU PYQ website (enforced by a unit test).
 */

export const LINK_CATEGORIES = [
  {
    id: 'student',
    title: 'Student & academic portals',
    icon: 'user',
    links: [
      { title: 'Samarth Student Portal', url: 'https://dsmru.samarth.edu.in/index.php/site/login', icon: 'user', description: 'Access your student profile, courses, and academic records.' },
      { title: 'Result Portal', url: 'https://dsmru.up.nic.in/main/User/results.aspx', icon: 'eye', description: 'Check your semester and examination results.' },
      { title: 'Backup Result Portal', url: 'https://dsmnru.ac.in/Results', icon: 'eye', description: 'Check your semester and examination results. University + affiliated colleges.' },
      { title: 'Notice Portal', url: 'https://dsmru.up.nic.in/main/User/Notices.aspx', icon: 'flag', description: 'Official notices, circulars, and announcements.' },
      { title: 'DSMNRU ERP Portal', url: 'https://dsmnruerp.in/', icon: 'bank', description: "University's Enterprise Resource Planning system." },
    ],
  },
  {
    id: 'admissions',
    title: 'Admissions & university life',
    icon: 'bank',
    links: [
      { title: 'Admission Portal', url: 'https://dsmnru.ac.in/', icon: 'bank', description: 'Main portal for new student admissions and information.' },
      { title: 'Merit/Counselling Notices', url: 'https://dsmnru.ac.in/AdmissionResult', icon: 'star', description: 'Merit lists and counselling schedules for admissions.' },
      { title: 'Convocation Portal', url: 'https://dsmru.samarth.edu.in/convocation', icon: 'courses', description: 'Information and registration for convocation ceremonies.' },
      { title: 'Alumni Portal', url: 'https://dsmru.samarth.edu.in/alumni', icon: 'users', description: 'Connect with fellow alumni and stay updated with the university.' },
    ],
  },
  {
    id: 'scholarships',
    title: 'Financial aid & scholarships',
    icon: 'rupee',
    links: [
      { title: 'UP Scholarship Portal', url: 'https://scholarship.up.gov.in/', icon: 'rupee', description: 'Apply for state-level scholarships from the UP Government.' },
      { title: 'National Scholarship Portal', url: 'https://scholarships.gov.in/', icon: 'star', description: 'Centralized portal for various national-level scholarships.' },
    ],
  },
  {
    id: 'admin',
    title: 'Administrative & other portals',
    icon: 'shield',
    links: [
      { title: 'Samarth Administration Portal', url: 'https://dsmru.samarth.ac.in/index.php/site/login', icon: 'bank', description: 'Portal for university administrative staff and services.' },
      { title: 'Grievance Portal', url: 'https://dsmru.samarth.ac.in/index.php/pgportal/grievance-public/public', icon: 'flag', description: 'Submit and track grievances and complaints.' },
      { title: 'Company Registration', url: 'https://dsmru.samarth.ac.in/index.php/training/company-profile-requests/register', icon: 'briefcase', description: 'For companies to register for campus placements and training.' },
    ],
  },
];

export const SITE_LINK_COUNT = LINK_CATEGORIES.reduce((n, c) => n + c.links.length, 0);
