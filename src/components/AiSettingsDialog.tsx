import { useEffect, useState } from 'react';
import { getApiKey, MODEL, setApiKey } from '../ai/claude';
import { checkAccess, serviceBuild, type AccessInfo } from '../ai/service';

/** The web app's access code: the server holds the model key and caps each code's daily use. */
function AccessCodeSection({ onDone }: { onDone: () => void }) {
  const [info, setInfo] = useState<AccessInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const i = await checkAccess();
      setInfo(i);
    } catch (e) {
      setInfo(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <h4>Company AI usage</h4>
      {info && (
        <p className="muted">
          Signed in as {info.name}. {info.used} of {info.limit} AI requests used today.
        </p>
      )}
      {error && <p className="field-hint error">{error}</p>}
      <p className="muted">
        AI features use your signed-in company account. Model credentials are managed by your company, not stored in this browser. Projects and drawings are shared with company members.
      </p>
      <div className="row-actions">
        <button className="on" disabled={checking} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Refresh usage'}
        </button>
        <button onClick={onDone}>Done</button>
      </div>
    </>
  );
}

function ApiKeySection({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState(getApiKey() ?? '');
  const saved = getApiKey();
  return (
    <>
      <label className="stack">
        Anthropic API key
        <input type="password" autoComplete="off" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <p className="muted">
        Get a key at console.anthropic.com. It is stored only in this browser on this computer. AI features send the
        sheet you choose to Anthropic's API; everything else stays local. Model: <code>{MODEL}</code>.
      </p>
      <div className="row-actions">
        <button
          className="on"
          disabled={!key.trim()}
          onClick={() => {
            setApiKey(key.trim());
            onDone();
          }}
        >
          Save
        </button>
        {saved && (
          <button
            onClick={() => {
              setApiKey(null);
              setKey('');
            }}
          >
            Remove key
          </button>
        )}
      </div>
    </>
  );
}

export function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h3>AI settings</h3>
          <button onClick={onClose}>Close</button>
        </div>
        {serviceBuild ? <AccessCodeSection onDone={onClose} /> : <ApiKeySection onDone={onClose} />}
      </div>
    </div>
  );
}
