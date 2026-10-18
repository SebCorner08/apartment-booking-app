"use strict";

const assert = require("assert");
const fs = require("fs");

const index = fs.readFileSync("public/index.html", "utf8");
const styles = fs.readFileSync("public/style.css", "utf8");
const sitemap = fs.readFileSync("public/sitemap.xml", "utf8");
const contactStart = index.indexOf('id="contact-info"');
const contactEnd = index.indexOf("</section>", contactStart);
const mainEnd = index.indexOf("</main>", contactStart);
const footerStart = index.indexOf("<footer>", contactStart);

assert(contactStart >= 0, "homepage must contain the Contact section");
assert(
  contactEnd > contactStart && mainEnd > contactEnd && footerStart > mainEnd,
  "Contact must be the final homepage section, before the footer",
);
assert(
  (index.match(/href="#contact-info"/g) || []).length >= 2,
  "desktop and mobile navigation must point to the in-page section",
);
assert(
  !index.includes("contact.html") && !sitemap.includes("contact.html"),
  "Contact must not link to or publish a separate page",
);

const contactSection = index.slice(contactStart, contactEnd);
const contactActions = [
  ["tel:+15402356297", "contact-call"],
  ["sms:+15402356297", "contact-text"],
  ["https://wa.me/15402356297", "contact-whatsapp"],
];
for (const [href, className] of contactActions) {
  assert(
    contactSection.includes(`href="${href}`) &&
      contactSection.includes(className),
    `Contact section must have a ${className} action`,
  );
}
assert(
  (contactSection.match(/class="homepage-contact-option(?:\s|")/g) || [])
    .length === 3,
  "Contact section must show three colorful action cards",
);
assert(
  !/\+?1?\s*540\s*235\s*6297/.test(
    contactSection.replace(/<[^>]*>/g, " "),
  ),
  "Contact section must not display the phone number",
);

assert(
  index.includes('<details class="contact-fab">') &&
    index.includes('aria-label="Contact us by phone or text message"') &&
    index.includes('class="contact-fab-icon"'),
  "the existing floating chat button and icon must remain on the homepage",
);
const floatingMenuStart = index.indexOf('<details class="contact-fab">');
const floatingMenuEnd = index.indexOf("</details>", floatingMenuStart);
const floatingMenu = index.slice(floatingMenuStart, floatingMenuEnd);
for (const [href] of contactActions) {
  assert(
    floatingMenu.includes(`href="${href}`),
    `the floating chat menu must retain a ${href} action`,
  );
}
assert(
  !fs.existsSync("public/contact.html") &&
    !fs.existsSync("public/contact.css") &&
    !index.includes("contact.html"),
  "Contact must not be implemented as a separate page",
);
assert(
  fs.existsSync("public/images/message-circle-more.png") &&
    styles.includes('url("images/message-circle-more.png")'),
  "the floating chat icon asset must remain available",
);
assert(
  /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/.test(styles) &&
    /@media\s*\(max-width:\s*850px\)[\s\S]*?grid-template-columns:\s*1fr/.test(
      styles,
    ),
  "Contact cards must use three columns on desktop and stack on small screens",
);

console.log("homepage contact section and floating chat regression check passed");
