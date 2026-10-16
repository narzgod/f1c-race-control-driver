import React, { useState, useEffect, useCallback, useRef } from "react";
import { Flag as FlagIcon, LogOut, User, CheckCircle2 } from "lucide-react";

/* ---------------------------------------------------------------------- */
/*  DRIVER-ONLY BUILD                                                     */
/*  This is the driver half of F1C Race Control, split out into its own  */
/*  standalone site so it can be deployed and shared with a separate URL */
/*  from the admin panel. It still talks to the exact same Firebase      */
/*  Realtime Database node as the admin site - DATABASE_URL and          */
/*  STATE_PATH below MUST always match the admin build's values, or the  */
/*  two sites will simply be looking at different data.                  */
/* ---------------------------------------------------------------------- */

/* ---------------------------------------------------------------------- */
/*  FIREBASE REALTIME DATABASE — VIA REST, NOT THE SDK                    */
/*  The firebase/database SDK opens a persistent WebSocket, which has     */
/*  proven unreliable on some mobile networks (connects to the Console   */
/*  fine over normal HTTPS, but the WebSocket handshake for onValue()    */
/*  never completes -> "No response from Firebase after 8 seconds").     */
/*  Plain REST (fetch + short polling) avoids that failure mode          */
/*  entirely and needs no extra npm package.                             */
/* ---------------------------------------------------------------------- */

const DATABASE_URL = "https://f1c-race-control-1f893-default-rtdb.asia-southeast1.firebasedatabase.app";
const STATE_PATH = "f1c-race-control-state";

// The driver screen needs to feel instant, since a Red Light / penalty flag
// is time-critical - so it always polls fast, unlike the admin build which
// only needs to poll fast while an admin has the driver-facing preview open.
const POLL_MS = 400;

/* ---------------------------------------------------------------------- */
/*  CONSTANTS                                                             */
/* ---------------------------------------------------------------------- */

const INK = "#0A0A0A";
const RED = "#E10600";
const YELLOW = "#FFD400";
const GREEN = "#00A651";
const BLUE = "#0057FF";
const MUTED = "#8A8A8A";
const MUTED_DARK = "#5C5C5C";
const LINE = "#2A2A2A";

const COLORS = {
  red: { bg: RED, text: "#FFFFFF", border: RED },
  yellow: { bg: YELLOW, text: "#0A0A0A", border: YELLOW },
  green: { bg: GREEN, text: "#FFFFFF", border: GREEN },
  blue: { bg: BLUE, text: "#FFFFFF", border: BLUE },
  black: { bg: "#0A0A0A", text: "#FFFFFF", border: "#FFFFFF" },
  white: { bg: "#FFFFFF", text: "#0A0A0A", border: "#FFFFFF" },
};

// Kept identical to the admin build's defaultState/normalizeState shape.
// This app writes the WHOLE state object back on every save (registerDriver
// -> mutate), so if this shape ever drifts from the admin build's shape,
// a driver registering could silently wipe out fields the admin build
// expects (flags, penalties, penaltyHistory, etc). Keep these two schemas
// in sync any time either build's data shape changes.
const defaultState = () => ({
  lobbyOpen: true,
  drivers: [],
  raceInfoItems: [
    { id: "red-light", name: "RED LIGHT", color: "red", subText: "BE READY", textColor: null },
    { id: "green-light", name: "GREEN LIGHT", color: "green", subText: "GO! GO! GO!", textColor: null },
    { id: "safety-car-out", name: "SAFETY CAR OUT", color: "yellow", subText: "", textColor: null },
    { id: "safety-car-in", name: "SAFETY CAR IN", color: "yellow", subText: "", textColor: null },
    { id: "no-overtake", name: "NO OVERTAKE", color: "blue", subText: "", textColor: null },
    { id: "no-closing-gap", name: "NO CLOSING GAP", color: "blue", subText: "", textColor: null },
  ],
  flags: [
    { id: "yellow-flag", name: "YELLOW FLAG", color: "yellow", target: false, subText: "", textColor: null },
    { id: "chequered-flag", name: "CHEQUERED FLAG", color: "black", target: false, subText: "", textColor: null },
    { id: "blue-flag", name: "BLUE FLAG", color: "blue", target: true, subText: "", textColor: null },
    { id: "black-flag", name: "BLACK FLAG", color: "black", target: true, subText: "", textColor: null },
    { id: "white-flag", name: "WHITE FLAG", color: "white", target: true, subText: "", textColor: null },
    { id: "black-white-flag", name: "BLACK & WHITE FLAG", color: "black", target: true, subText: "", textColor: null },
  ],
  penalties: [
    { id: "penalty-5s", name: "5 SEC TIME PENALTY", color: "red", target: true, subText: "", textColor: null },
    { id: "penalty-10s", name: "10 SEC TIME PENALTY", color: "red", target: true, subText: "", textColor: null },
    { id: "penalty-drivethrough", name: "DRIVE THROUGH PENALTY", color: "red", target: true, subText: "", textColor: null },
    { id: "penalty-stopgo", name: "STOP & GO PENALTY", color: "red", target: true, subText: "", textColor: null },
    { id: "penalty-tracklimits", name: "TRACK LIMITS WARNING", color: "yellow", target: true, subText: "", textColor: null },
    { id: "penalty-dsq", name: "DISQUALIFICATION", color: "black", target: true, subText: "", textColor: null },
  ],
  activeSignals: [],
  penaltyHistory: [],
  updatedAt: 0,
});

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Driver names may only contain letters, spaces, and periods (e.g.
// "L.Verstappen") - no digits or symbols like # $ & ) +. Applied live on
// every keystroke so an invalid character is simply never typed.
const sanitizeDriverName = (value) => value.replace(/[^A-Za-z. ]/g, "");

// Guarantees every expected field exists and is the right shape, no matter
// what is actually sitting in the database (partial writes, manual edits in
// the Firebase console, leftovers from an earlier test, etc). Without this,
// a single malformed field crashes the whole app with "cannot read
// properties of undefined".
function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object") return base;
  return {
    ...base,
    ...raw,
    lobbyOpen: typeof raw.lobbyOpen === "boolean" ? raw.lobbyOpen : base.lobbyOpen,
    drivers: Array.isArray(raw.drivers) ? raw.drivers : base.drivers,
    raceInfoItems: Array.isArray(raw.raceInfoItems) ? raw.raceInfoItems : base.raceInfoItems,
    flags: Array.isArray(raw.flags) ? raw.flags : base.flags,
    penalties: Array.isArray(raw.penalties) ? raw.penalties : base.penalties,
    activeSignals: Array.isArray(raw.activeSignals) ? raw.activeSignals : base.activeSignals,
    penaltyHistory: Array.isArray(raw.penaltyHistory) ? raw.penaltyHistory : base.penaltyHistory,
  };
}

/* ---------------------------------------------------------------------- */
/*  FIREBASE REST READ / WRITE / POLL HELPERS                             */
/*  No persistent connection is kept open. subscribeToState() fires       */
/*  immediately with the current value, then re-fetches every POLL_MS -   */
/*  that's what keeps this driver screen in sync with the admin site.     */
/* ---------------------------------------------------------------------- */

async function fetchState() {
  const res = await fetch(`${DATABASE_URL}/${STATE_PATH}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Firebase REST error: HTTP ${res.status}`);
  return res.json();
}

async function saveState(next) {
  const payload = { ...next, updatedAt: Date.now() };
  const res = await fetch(`${DATABASE_URL}/${STATE_PATH}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Firebase REST error: HTTP ${res.status}`);
  return payload;
}

function subscribeToState(onData, onError, pollMs = POLL_MS) {
  let stopped = false;
  let intervalId = null;

  const poll = async () => {
    try {
      const data = await fetchState();
      if (stopped) return;
      if (data) {
        onData(normalizeState(data));
      } else {
        // Nothing in the database yet - seed it with the defaults.
        const fresh = defaultState();
        await saveState(fresh);
        if (!stopped) onData(fresh);
      }
      if (!stopped) onError(null);
    } catch (e) {
      if (!stopped) onError(e.message || String(e));
    }
  };

  const start = () => {
    if (intervalId) return;
    poll();
    intervalId = setInterval(poll, pollMs);
  };

  const stop = () => {
    if (!intervalId) return;
    clearInterval(intervalId);
    intervalId = null;
  };

  // Pause polling while the screen/tab is hidden (phone locked, app
  // backgrounded) to save battery and data, and immediately poll again the
  // instant it becomes visible so the driver sees the latest signal right
  // when they look back at the phone instead of waiting for the next tick.
  const handleVisibility = () => {
    if (document.visibilityState === "visible") {
      start();
    } else {
      stop();
    }
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibility);
  }

  start();

  return () => {
    stopped = true;
    stop();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleVisibility);
    }
  };
}

/* ---------------------------------------------------------------------- */
/*  GLOBAL STYLE (plain CSS - always applies, no build step needed)       */
/* ---------------------------------------------------------------------- */

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800;900&display=swap');
      .f1-root, .f1-root * { box-sizing: border-box; }
      .f1-root { font-family: 'Barlow Condensed','Arial Narrow',sans-serif; }
      .f1-btn-white { background:#fff; color:${INK}; border:none; transition: background .15s ease; }
      .f1-btn-white:hover { background:#d6d6d6; }
      .f1-btn-outline { background:transparent; color:#fff; border:1px solid #525252; transition: border-color .15s ease; }
      .f1-btn-outline:hover { border-color:#fff; }
      .f1-input { background:transparent; color:#fff; border:1px solid #525252; outline:none; transition:border-color .15s ease; }
      .f1-input::placeholder { color:#666; }
      .f1-input-w:focus { border-color:#fff; }
      .f1-link { color:${MUTED}; transition:color .15s ease; background:none; border:none; }
      .f1-link:hover { color:#fff; }
    `}</style>
  );
}

/* ---------------------------------------------------------------------- */
/*  SMALL UI PRIMITIVES                                                   */
/* ---------------------------------------------------------------------- */

function Label({ children }) {
  return (
    <p className="font-semibold uppercase" style={{ fontSize: 11, letterSpacing: "0.3em", color: MUTED }}>
      {children}
    </p>
  );
}

/* ---------------------------------------------------------------------- */
/*  DRIVER LOGIN / REGISTRATION                                           */
/* ---------------------------------------------------------------------- */

function DriverLoginView({ onSuccess, lobbyOpen, registerDriver }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter your driver name to continue.");
      return;
    }
    if (!/^[A-Za-z. ]+$/.test(trimmed)) {
      setError("Nama hanya boleh berisi huruf dan titik (.), tanpa angka atau simbol.");
      return;
    }
    if (!lobbyOpen) {
      setError("Lobby is closed. Wait for race control to reopen registration.");
      return;
    }
    try {
      const driver = await registerDriver(trimmed);
      onSuccess(driver);
    } catch (e) {
      setError("Failed to connect: " + (e.message || String(e)));
    }
  };

  return (
    <div className="f1-root min-h-screen flex flex-col justify-center px-6 py-16" style={{ background: INK, color: "#fff" }}>
      <div className="max-w-md mx-auto w-full">
        <div className="flex items-center gap-2 mb-3" style={{ color: GREEN }}>
          <User size={15} />
          <span className="uppercase font-bold" style={{ fontSize: 12, letterSpacing: "0.3em" }}>
            Driver Lobby
          </span>
        </div>
        <h2 className="font-black uppercase" style={{ fontSize: 34, marginBottom: 16 }}>
          Enter The Grid
        </h2>
        <p style={{ color: "#a8a8a8", fontSize: 14, lineHeight: 1.6, marginBottom: 28 }}>
          Register your driver name to receive live race control notifications.
        </p>

        <Label>Driver Name</Label>
        <input
          type="text"
          value={name}
          onChange={(e) => {
            setName(sanitizeDriverName(e.target.value));
            setError("");
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Contoh: L.Verstappen"
          className="f1-input f1-input-w w-full mt-2 mb-4 px-4 py-4 font-semibold"
        />
        <p className="uppercase font-semibold" style={{ color: MUTED_DARK, fontSize: 10, letterSpacing: "0.08em", marginTop: -8, marginBottom: 16 }}>
          Hanya huruf dan titik (.) — tanpa angka atau simbol.
        </p>
        {error && (
          <p className="uppercase font-bold mb-4" style={{ color: RED, fontSize: 12 }}>
            {error}
          </p>
        )}
        {!lobbyOpen && (
          <p className="uppercase font-bold mb-4" style={{ color: YELLOW, fontSize: 12 }}>
            Lobby is currently closed by race control.
          </p>
        )}

        <button onClick={submit} className="f1-btn-white w-full active:scale-95 transition-transform font-black uppercase py-5 text-lg">
          Enter Grid
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  DRIVER CONSOLE                                                        */
/* ---------------------------------------------------------------------- */

function DriverConsole({ driver, signals, onExit }) {
  // Signals stack in ONE shared slot (not a list) - whichever was activated
  // most recently is rendered last, so it naturally paints on top and fully
  // covers whatever was active before it (e.g. activating YELLOW FLAG while
  // RED LIGHT is showing replaces it completely, not side-by-side). This
  // relies on every frame being fully OPAQUE: Frame A uses its configured
  // color, and Frame B uses a solid near-black fill (matching the page
  // background, so it still reads as "no background") instead of literal
  // CSS transparent - a truly transparent Frame B would let whatever is
  // behind it show through and visually collide with its text.
  const bannerHeight = 96;

  // Every active signal alternates between two "frames" every 700ms:
  //   Frame A - the main label, shown with its configured background color
  //   Frame B - a secondary line, shown with a plain black fill (no color)
  // For driver-targeted flags/penalties, Frame A is the driver's name and
  // Frame B is the flag/penalty name (e.g. "M.VERSTAPPEN" -> "5 SEC TIME
  // PENALTY"). For everything else, Frame A is the item name and Frame B is
  // its configured Secondary Text (e.g. RED LIGHT -> BE READY), falling
  // back to repeating the item name if no Secondary Text was set by admin.
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (signals.length === 0) return undefined;
    const id = setInterval(() => setFrame((f) => (f === 0 ? 1 : 0)), 700);
    return () => clearInterval(id);
  }, [signals.length]);

  return (
    <div className="f1-root min-h-screen flex flex-col" style={{ background: INK, color: "#fff" }}>
      <div className="fixed top-0 left-0 right-0" style={{ zIndex: 40, height: signals.length > 0 ? bannerHeight : 0 }}>
        {signals.map((s) => {
          const palette = COLORS[s.color] || COLORS.red;
          const isTargeted = !!s.driverName;

          const primaryText = isTargeted ? s.driverName : s.name;
          const secondaryText = isTargeted
            ? s.name
            : s.subText && s.subText.trim()
            ? s.subText
            : s.name;

          // Custom text color always wins if the admin set one. Otherwise,
          // Frame A uses the palette's readable text color, and Frame B uses
          // the item's own accent color as text on the black banner fill -
          // except for "black", which would be invisible on a black fill,
          // so that one case falls back to white.
          const customColor = s.textColor && s.textColor.trim() ? s.textColor : null;
          const frameAColor = customColor || palette.text;
          const frameBColor = customColor || (s.color === "black" ? "#FFFFFF" : palette.bg);

          const showingPrimary = frame === 0;
          const displayText = showingPrimary ? primaryText : secondaryText;
          const displayBg = showingPrimary ? palette.bg : INK;
          const displayColor = showingPrimary ? frameAColor : frameBColor;

          const textOutline = {
            WebkitTextStroke: "1px rgba(0,0,0,0.85)",
            textShadow: "0 1px 2px rgba(0,0,0,0.7)",
          };

          return (
            <div
              key={s.uid}
              className="absolute inset-0 w-full h-full py-3 px-5 flex flex-col items-center justify-center gap-0.5"
              style={{ background: displayBg, borderBottom: "1px solid #000" }}
            >
              <p
                className="font-semibold uppercase text-center"
                style={{ color: displayColor, fontSize: 26, lineHeight: 1.2, letterSpacing: "0.02em", ...textOutline }}
              >
                {displayText}
              </p>
            </div>
          );
        })}
      </div>

      <div
        className="flex items-center justify-between px-4 py-4"
        style={{ borderBottom: `1px solid ${LINE}`, marginTop: signals.length > 0 ? bannerHeight : 0 }}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center" style={{ width: 36, height: 36, background: "#fff" }}>
            <FlagIcon size={16} color={INK} />
          </div>
          <div>
            <p className="font-black uppercase text-white text-sm leading-none">F1C Driver Console</p>
            <span className="flex items-center gap-1 font-bold mt-1" style={{ fontSize: 10, color: GREEN, letterSpacing: "0.05em" }}>
              <span className="rounded-full" style={{ width: 6, height: 6, background: GREEN }} /> SIGNAL LIVE
            </span>
          </div>
        </div>
        <button onClick={onExit} className="f1-btn-outline flex items-center gap-1.5 px-3 py-2 text-xs font-black uppercase">
          <LogOut size={13} /> Exit
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 gap-6">
        <div className="text-center">
          <Label>Driver</Label>
          <p className="font-black uppercase text-white mt-1" style={{ fontSize: 30 }}>
            {driver.name}
          </p>
        </div>

        {signals.length === 0 ? (
          <>
            <div className="w-full max-w-xs" style={{ height: 1, background: LINE }} />
            <p className="uppercase font-semibold" style={{ fontSize: 12, letterSpacing: "0.2em", color: MUTED_DARK }}>
              Awaiting race control
            </p>
            <div className="flex items-center gap-2 px-4 py-3" style={{ border: `1px solid ${LINE}` }}>
              <span className="rounded-full" style={{ width: 8, height: 8, background: GREEN }} />
              <span className="uppercase font-bold" style={{ fontSize: 12, color: "#d4d4d4", letterSpacing: "0.03em" }}>
                Track clear. Stay ready.
              </span>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2 px-4 py-3" style={{ border: `1px solid ${LINE}` }}>
            <CheckCircle2 size={15} color={GREEN} />
            <span className="uppercase font-bold" style={{ fontSize: 12, color: "#d4d4d4", letterSpacing: "0.03em" }}>
              {signals.length} live signal{signals.length > 1 ? "s" : ""}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  ROOT APP                                                               */
/* ---------------------------------------------------------------------- */

export default function F1CDriverApp() {
  const [view, setView] = useState("login"); // "login" | "console"
  const [state, setState] = useState(defaultState());
  const [ready, setReady] = useState(false);
  const [connError, setConnError] = useState(null);
  const [currentDriver, setCurrentDriver] = useState(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Chains every Firebase write onto the previous one so they always
  // resolve in the same order requested, no matter how the network
  // delivers them. See mutate() below for why this matters.
  const writeQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    const unsubscribe = subscribeToState(
      (incoming) => {
        // Guard against an out-of-order network echo overwriting a click that
        // just happened locally, so registration always feels instant.
        if ((incoming.updatedAt || 0) >= (stateRef.current.updatedAt || 0)) {
          setState(incoming);
          stateRef.current = incoming;
        }
        setConnError(null);
        setReady(true);
      },
      (message) => {
        if (message) setConnError(message);
      },
      POLL_MS
    );

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    // If the currently-logged-in driver gets removed from the roster by an
    // admin, kick them back to the registration screen automatically - their
    // session shouldn't keep showing signals for a driver that no longer
    // exists. state.drivers refreshes every POLL_MS via subscribeToState, so
    // this check re-runs shortly after the admin deletes them.
    if (view === "console" && currentDriver) {
      const stillRegistered = state.drivers.some((d) => d.id === currentDriver.id);
      if (!stillRegistered) {
        alert("Kamu telah dikeluarkan dari lobby oleh Race Control.");
        setCurrentDriver(null);
        setView("login");
      }
    }
  }, [state.drivers, view, currentDriver]);

  const mutate = useCallback((partial) => {
    const merged = { ...stateRef.current, ...partial, updatedAt: Date.now() };
    // Apply instantly and locally first so registration feels immediate,
    // even while a previous save is still in flight.
    setState(merged);
    stateRef.current = merged;

    // The actual network write is queued rather than fired immediately, so
    // writes always land at Firebase in the order they were requested -
    // otherwise an older, now-stale write landing after a newer one could
    // silently overwrite it.
    const run = () => saveState(merged);
    const queued = writeQueueRef.current.then(run, run);
    writeQueueRef.current = queued.then(
      () => {},
      () => {}
    );

    return queued.then(
      () => setConnError(null),
      (e) => {
        setConnError(e.message || String(e));
        throw e;
      }
    );
  }, []);

  const registerDriver = useCallback(
    async (name) => {
      const current = stateRef.current;
      const existing = current.drivers.find((d) => d.name.toLowerCase() === name.toLowerCase());
      if (existing) return existing;
      const driver = { id: genId(), name };
      await mutate({ drivers: [...current.drivers, driver] });
      return driver;
    },
    [mutate]
  );

  if (connError) {
    return (
      <div className="f1-root min-h-screen flex flex-col items-center justify-center px-6 text-center gap-4" style={{ background: INK, color: "#fff" }}>
        <GlobalStyle />
        <span className="uppercase font-black" style={{ fontSize: 16, letterSpacing: "0.1em", color: RED }}>
          Firebase Connection Error
        </span>
        <p style={{ color: "#d4d4d4", fontSize: 13, maxWidth: 420, lineHeight: 1.6, whiteSpace: "pre-line" }}>
          {connError}
        </p>
        <p className="uppercase font-semibold" style={{ color: MUTED_DARK, fontSize: 11, letterSpacing: "0.1em", maxWidth: 420, lineHeight: 1.6 }}>
          Cek DATABASE_URL di App.jsx dan Realtime Database Rules di Firebase Console.
        </p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="f1-root min-h-screen flex items-center justify-center" style={{ background: INK, color: "#fff" }}>
        <GlobalStyle />
        <span className="uppercase font-bold" style={{ fontSize: 12, letterSpacing: "0.3em", color: "#525252" }}>
          Loading race control…
        </span>
      </div>
    );
  }

  return (
    <div className="f1-root">
      <GlobalStyle />

      {view === "login" && (
        <DriverLoginView
          lobbyOpen={state.lobbyOpen}
          registerDriver={registerDriver}
          onSuccess={(driver) => {
            setCurrentDriver(driver);
            setView("console");
          }}
        />
      )}

      {view === "console" && currentDriver && (
        <DriverConsole
          driver={currentDriver}
          signals={state.activeSignals}
          onExit={() => {
            setCurrentDriver(null);
            setView("login");
          }}
        />
      )}
    </div>
  );
}
