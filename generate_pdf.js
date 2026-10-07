const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  const htmlPath = path.resolve('/Users/krishnalalagarwal/Public Credit/INTERVIEW_PREP.html');
  const fileUrl = 'file://' + htmlPath;
  
  await page.goto(fileUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000); // Wait for mermaid to render
  
  // Check if mermaid is loaded
  await page.evaluate(() => {
    if (window.mermaid) {
      mermaid.initialize({ startOnLoad: true });
    }
  });
  await page.waitForTimeout(2000);
  
  await page.pdf({
    path: '/Users/krishnalalagarwal/Public Credit/INTERVIEW_PREP.pdf',
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' },
    preferCSSPageSize: true,
  });
  
  await browser.close();
  console.log('PDF generated successfully!');
})();