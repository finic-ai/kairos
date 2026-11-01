export function automation(nav: Pick<Navigator, "webdriver" | "userAgent"> = navigator): {
  webdriver: boolean;
  headless: boolean;
} {
  return { webdriver: nav.webdriver === true, headless: /HeadlessChrome|PhantomJS/.test(nav.userAgent) };
}
