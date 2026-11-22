/**
 * Help page: how to try the dashboard, in the language chosen in the header.
 *
 * The text lives in `COPY.help` (English in `copy.ts`, Japanese in `copy.ja.ts`), so the language
 * switch changes this page together with every other one. Presentational only.
 */
import { COPY } from "../content/copy";

export function Help() {
  const help = COPY.help;
  return (
    <main className="page help">
      <h1>{help.heading}</h1>
      <p className="help__intro">{help.intro}</p>
      {help.sections.map((section, index) => (
        <section key={index} className="help__section" aria-labelledby={`help-section-${index}`}>
          <h2 id={`help-section-${index}`}>{section.title}</h2>
          <ul>
            {section.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
