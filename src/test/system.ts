// Every test run sees the same computer as CI's Linux runners, whatever it runs on: an English (US) locale, UTC, and a
// Linux platform. Dates, numbers and the words for "this computer" come out alike on a Mac, on Windows, and in any
// country. Node takes its locale from Windows' own settings there, not from LANG, so the default locale is pinned
// where it is read: a format asked for without a locale (or with `[]`) gets en-US. A test that sets a locale or a platform still
// gets its own.

const LOCALE = "en-US";

process.env.TZ = "UTC";

type Locales = string | string[] | undefined;
/** No locale, or none of `[]`: the default, which is pinned. */
const or = (locales: Locales) => (locales === undefined || (Array.isArray(locales) && locales.length === 0) ? LOCALE : locales);
const intl = Intl as unknown as Record<string, new (locales?: Locales, options?: object) => object>;
for (const name of ["DateTimeFormat", "NumberFormat", "PluralRules", "RelativeTimeFormat", "ListFormat", "DisplayNames", "Collator", "Segmenter"]) {
  const Original = intl[name];
  if (!Original) continue;
  intl[name] = new Proxy(Original, {
    construct: (target, [locales, ...rest]: [Locales, ...unknown[]]) => new target(or(locales), ...(rest as [object?])),
    apply: (target, self, [locales, ...rest]: [Locales, ...unknown[]]) => Reflect.apply(target, self, [or(locales), ...rest]),
  });
}

function pin<T extends object>(prototype: T, method: keyof T) {
  const original = prototype[method] as unknown as (this: unknown, locales?: Locales, ...rest: unknown[]) => unknown;
  Object.defineProperty(prototype, method, {
    configurable: true,
    writable: true,
    value: function (this: unknown, locales?: Locales, ...rest: unknown[]) {
      return original.call(this, or(locales), ...rest);
    },
  });
}
pin(Date.prototype, "toLocaleString");
pin(Date.prototype, "toLocaleDateString");
pin(Date.prototype, "toLocaleTimeString");
pin(Number.prototype, "toLocaleString");
pin(BigInt.prototype, "toLocaleString");

// Node reports its own platform ("Win32", "MacIntel"); jsdom's is empty. Neither is set by a test that wants another.
if (typeof navigator !== "undefined" && !navigator.platform.startsWith("Linux") && navigator.platform !== "") {
  Object.defineProperty(navigator, "platform", { configurable: true, get: () => "Linux x86_64" });
}
