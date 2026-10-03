import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "./api";
import { navigate } from "./router";
import { hrefFor } from "./route";
import { Link } from "./router";
import { Shell } from "./shell";
import { slugify, validateSlug } from "./wizardLogic";

export function NewProject() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const nameId = useId();
  const slugId = useId();

  const effectiveSlug = slugTouched ? slug : slugify(name);
  const nameErr = !name.trim() ? "Give your project a name" : name.length > 80 ? "Max 80 characters" : null;
  const slugErr = validateSlug(effectiveSlug);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (nameErr || slugErr || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.startGenesis(effectiveSlug, name.trim());
      navigate(hrefFor.setup(effectiveSlug));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Shell crumbs={[{ label: "NEW PROJECT" }]}>
      <form className="panel form form--narrow" onSubmit={(e) => void submit(e)} noValidate>
        <p className="eyebrow">NEW PROJECT</p>
        <h2 className="form__title">Name your hive</h2>
        <p className="muted">The slug becomes the repo name and the Queen's address. You cannot change it later.</p>
        <div className="field">
          <label htmlFor={nameId}>Project name</label>
          <input id={nameId} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Pixel Pulse" maxLength={120} aria-invalid={submitted && !!nameErr} aria-describedby={`${nameId}-e`} />
          <small id={`${nameId}-e`} className="field__err">{submitted && nameErr}</small>
        </div>
        <div className="field">
          <label htmlFor={slugId}>Hive slug</label>
          <input
            id={slugId}
            className="mono"
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
            placeholder="pixel-pulse"
            spellCheck={false}
            autoCapitalize="none"
            aria-invalid={(submitted || slugTouched) && !!slugErr}
            aria-describedby={`${slugId}-e`}
          />
          <small id={`${slugId}-e`} className={(submitted || slugTouched) && slugErr ? "field__err" : "field__hint"}>
            {(submitted || slugTouched) && slugErr ? slugErr : "lowercase letters, digits and dashes; 3-32 chars"}
          </small>
        </div>
        {error && <div className="notice notice--error" role="alert"><b>Could not create project</b><span>{error}</span></div>}
        <div className="form__actions">
          <Link to={hrefFor.home()} className="btn">Cancel</Link>
          <button className="btn btn--primary btn--big" type="submit" disabled={busy}>{busy ? "Creating…" : "Start describing →"}</button>
        </div>
      </form>
    </Shell>
  );
}
