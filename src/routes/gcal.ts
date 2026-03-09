import { Router } from "express";
import { config } from "../config.js";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: CachedToken | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const params = new URLSearchParams({
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    refresh_token: config.googleRefreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return tokenCache.accessToken;
}

const ALLOWED_CALENDARS = [
  "robin@knapsack.cloud",
  "robin.cannon@gmail.com",
  "family10988690493973800187@group.calendar.google.com",
  "kimm.hopson@gmail.com",
];
const KIM_CALENDAR_ID = "kimm.hopson@gmail.com";
const ROBIN_CALENDARS = ALLOWED_CALENDARS.filter((id) => id !== KIM_CALENDAR_ID);

type GCalEvent = {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  status?: string;
  organizer?: { email?: string };
};

type SlimEvent = {
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  status: string;
  organizer: string;
  kimOnly?: true;
  sharedWithKim?: true;
};

function slimEvent(ev: GCalEvent, extra?: Partial<SlimEvent>): SlimEvent {
  return {
    summary: ev.summary || "(no title)",
    start: ev.start || {},
    end: ev.end || {},
    status: ev.status || "confirmed",
    organizer: ev.organizer?.email || "",
    ...extra,
  };
}

function eventKey(ev: GCalEvent): string {
  return `${ev.summary || ""}|${ev.start?.dateTime || ev.start?.date || ""}`;
}

export function createGcalRouter(): Router {
  const router = Router();

  router.get("/events", async (req, res) => {
    try {
      const token = await getAccessToken();
      const now = new Date();
      const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const timeMin = now.toISOString();
      const timeMax = sevenDays.toISOString();
      const calId = req.query.cal as string | undefined;

      if (calId === "all") {
        const calendarEvents = new Map<string, GCalEvent[]>();
        await Promise.all(
          ALLOWED_CALENDARS.map(async (id) => {
            const evRes = await fetch(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events?` +
                new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime" }),
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (evRes.ok) {
              const evData = (await evRes.json()) as { items: GCalEvent[] };
              calendarEvents.set(id, evData.items || []);
            }
          })
        );

        const kimKeys = new Set(
          (calendarEvents.get(KIM_CALENDAR_ID) || []).map(eventKey)
        );

        const result: SlimEvent[] = [];
        const seen = new Set<string>();

        for (const id of ROBIN_CALENDARS) {
          for (const ev of calendarEvents.get(id) || []) {
            const key = eventKey(ev);
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(slimEvent(ev, kimKeys.has(key) ? { sharedWithKim: true } : undefined));
          }
        }

        for (const ev of calendarEvents.get(KIM_CALENDAR_ID) || []) {
          const key = eventKey(ev);
          if (seen.has(key)) continue;
          seen.add(key);
          result.push(slimEvent(ev, { kimOnly: true }));
        }

        result.sort((a, b) => {
          const aTime = a.start.dateTime || a.start.date || "";
          const bTime = b.start.dateTime || b.start.date || "";
          return aTime.localeCompare(bTime);
        });

        res.json({ events: result });
      } else {
        const targetCal = calId || "primary";
        const evRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCal)}/events?` +
            new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime" }),
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!evRes.ok) {
          const err = await evRes.text();
          res.status(evRes.status).json({ error: err });
          return;
        }
        const evData = (await evRes.json()) as { items: GCalEvent[] };
        res.json({ events: (evData.items || []).map((ev) => slimEvent(ev)) });
      }
    } catch (err) {
      console.error("gcal/events error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
