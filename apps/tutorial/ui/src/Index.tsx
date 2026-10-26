/**
 * The landing page: every section, and its tutorials as cards.
 *
 * The sidebar already lists all of this, and the duplication is deliberate — the
 * sidebar answers "where am I", and this answers "what is here and what is it
 * for", which needs the blurb and does not fit in a rail. Opening straight onto
 * a tutorial instead was considered and dropped: a reader arriving from the
 * switcher has not chosen anything yet, and choosing for them makes the first
 * screen feel like it lost their place.
 */
import type { Catalog } from "./useCatalog";
import { Check } from "./icons";

export default function Index({
  catalog,
  isDone,
  onOpen,
}: {
  catalog: Catalog;
  isDone: (id: string) => boolean;
  onOpen: (id: string) => void;
}) {
  const sections = [...catalog.sections].sort((a, b) => a.order - b.order);
  const left = catalog.tutorials.filter((t) => !isDone(t.id)).length;

  return (
    <div className="tut__index">
      <header className="tut__index-head">
        <h1>Tutorials</h1>
        <p className="tut__index-blurb">
          Short walkthroughs of what Veistra does today. Each one is a page you can read beside the
          thing it describes — put this tab in one pane and work in the other.
        </p>
        <p className="tut__index-count">
          {left === 0
            ? "You have read all of them."
            : `${left} left, about ${minutes(catalog, isDone)} minutes in total.`}
        </p>
      </header>

      {sections.map((section) => (
        <section key={section.id} className="tut__index-section">
          <h2>{section.title}</h2>
          <p className="tut__index-section-blurb">{section.description}</p>
          <ul className="tut__cards">
            {catalog.tutorials
              .filter((tutorial) => tutorial.section === section.id)
              .map((tutorial) => (
                <li key={tutorial.id}>
                  <button
                    type="button"
                    className={`tut__card${isDone(tutorial.id) ? " tut__card--done" : ""}`}
                    onClick={() => onOpen(tutorial.id)}
                  >
                    <span className="tut__card-head">
                      <span className="tut__card-title">{tutorial.title}</span>
                      {isDone(tutorial.id) ? (
                        <span className="tut__card-done">
                          <Check size={11} /> done
                        </span>
                      ) : (
                        <span className="tut__card-min">{tutorial.minutes} min</span>
                      )}
                    </span>
                    <span className="tut__card-blurb">{tutorial.blurb}</span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** How long the unread ones take, together. */
function minutes(catalog: Catalog, isDone: (id: string) => boolean): number {
  return catalog.tutorials
    .filter((tutorial) => !isDone(tutorial.id))
    .reduce((total, tutorial) => total + tutorial.minutes, 0);
}
