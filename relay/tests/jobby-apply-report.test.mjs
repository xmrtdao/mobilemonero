// Does the tool pull the right questions out of what the page agent wrote?
//
// The three reports below are verbatim from live runs. The agent's formatting
// varies with what it found, so the shapes differ, and two of the three put the
// field index on a different side of the label.
//
// The important assertion is the negative one: fields the agent DID fill must
// not appear. A list containing "Email: joeyleepcs@gmail.com" tells the user
// nothing about what they are being asked for.
import { createJobbyTools, extractOutstanding } from '../jobby/tools.mjs';

let fails = 0;
const check = (label, cond, detail = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : `  -> ${JSON.stringify(detail)}`));
  if (!cond) fails++;
};

const MARKDOWN = `I have filled the job application form with the following information:

**Fields Filled:**
- Full Name: Joseph Andrew Lee
- Email: joeyleepcs@gmail.com
- Phone: +1 202 798 0610
- Location (City): Costa Rica

**Fields NOT Filled (require information not provided):**
- Resume: File upload field - I cannot upload files
- Source ("How did you hear about us?"): No value provided in applicant facts
- Referral ("Referring employee (if any)"): No value provided in applicant facts

**Submit Button:**
There is a "Submit application" button (index 12) at the bottom of the form. Per your instructions, I have not clicked it.`;

const NUMBERED = `Job application form partially completed.

Fields filled:
- Full name: Joseph Andrew Lee

Fields NOT filled (require action):
1. Resume [9]: File upload field - no resume file was provided in the applicant data.
2. How did you hear about us? [11]: This field asks for information NOT listed in the provided applicant facts.`;

const FLAT = `I stopped. I need:
- Work authorisation status: not stated anywhere in the dossier
- Notice period: unknown

Note: I did not submit anything.`;

console.log('--- markdown report with headed sections ---');
let out = extractOutstanding(MARKDOWN);
check('finds all three unanswered fields', out.length === 3, out.map(o => o.question));
check('does not include the fields it filled',
  !out.some(o => /email|full name|phone|location/i.test(o.question)), out.map(o => o.question));
check('captures the referral field', out.some(o => /referral/i.test(o.question)), out);
check('captures how-did-you-hear', out.some(o => /how did you hear/i.test(o.question)), out);
check('captures the file upload', out.some(o => /resume/i.test(o.question)), out);

console.log('\n--- numbered list with the index after the label ---');
out = extractOutstanding(NUMBERED);
check('finds both unanswered fields', out.length === 2, out.map(o => o.question));
check('does not include the filled field',
  !out.some(o => /full name/i.test(o.question)), out.map(o => o.question));
check('reads the index that follows the label',
  out.find(o => /resume/i.test(o.question))?.index === '9', out);
check('reads the second index',
  out.find(o => /hear about/i.test(o.question))?.index === '11', out);

console.log('\n--- a flat list with no headings ---');
out = extractOutstanding(FLAT);
check('still finds the two needs', out.length === 2, out.map(o => o.question));
check('work authorisation', out.some(o => /authorisation/i.test(o.question)), out);
check('notice period', out.some(o => /notice/i.test(o.question)), out);

console.log('\n--- robustness ---');
check('empty input', extractOutstanding('').length === 0);
check('null input', extractOutstanding(null).length === 0);
check('a report with nothing outstanding yields nothing',
  extractOutstanding('All fields were filled and the application was submitted.').length === 0);

const bundle = createJobbyTools({ llmChat: null });
check('jobby_apply registered', typeof bundle.jobby_apply === 'function');
check('jobby_browser_status registered', typeof bundle.jobby_browser_status === 'function');

console.log('\n' + (fails ? `${fails} FAILED` : 'all apply-report extraction checks passed'));
process.exit(fails ? 1 : 0);
