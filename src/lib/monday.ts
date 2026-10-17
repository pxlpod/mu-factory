import { MONDAY, alertFallbackItemId, type FactoryLabel } from "@/config/monday";

/**
 * Monday GraphQL client.
 *
 * COPIED FROM PHOTO-PUBLISHER AND CUT DOWN. The app needs four things from
 * Monday: read the Publishing board, verify it still has the columns config
 * says it has, deliver notifications — because in this house alerts are
 * Monday notifications and nothing else — and, since 2026-10-17, write ONE
 * column: `Factory` (`setFactory`, below). Status columns are written by INDEX,
 * never label, because label text is editable on the board and a rename would
 * silently stop every write. No other column is written before Phase 3.
 */

export class MondayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MondayError";
  }
}

function token(): string {
  const value = process.env.MONDAY_API_TOKEN;
  if (!value) throw new MondayError("MONDAY_API_TOKEN is not set");
  return value;
}

export async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(MONDAY.api, {
    method: "POST",
    headers: {
      Authorization: token(),
      "Content-Type": "application/json",
      "API-Version": MONDAY.apiVersion,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(MONDAY.requestTimeoutMs),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MondayError(
      `Monday API ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`,
      res.status,
    );
  }

  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
    error_message?: string;
  };

  // GraphQL errors arrive with HTTP 200, so this branch is not redundant.
  if (json.errors?.length) {
    throw new MondayError(json.errors.map((e) => e.message).join("; "));
  }
  if (json.error_message) throw new MondayError(json.error_message);
  if (!json.data) throw new MondayError("Monday API returned no data");
  return json.data;
}

// ---------------------------------------------------------------------------
// Column values (kept for Phase 2; unused by Phase 1 writes)
// ---------------------------------------------------------------------------

export type ColumnValues = Record<string, unknown>;

export function textValue(value: string | null): string {
  return value ?? "";
}

/**
 * Status columns are written as `{ index }`, never `{ label }` — and the
 * number is the label's ID (the key of the column's labels map), not its
 * display position. See `MONDAY.publishingStatus` for why that matters.
 */
export function statusValue(labelId: number): { index: number } {
  return { index: labelId };
}

export async function updateItem(
  boardId: string,
  itemId: string,
  columnValues: ColumnValues,
): Promise<void> {
  if (Object.keys(columnValues).length === 0) return;

  await gql(
    `mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
       change_multiple_column_values (
         board_id: $boardId,
         item_id: $itemId,
         column_values: $values,
         create_labels_if_missing: false
       ) { id }
     }`,
    { boardId, itemId, values: JSON.stringify(columnValues) },
  );
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

interface RawItem {
  id: string;
  name: string;
  created_at: string;
  column_values: Array<{ id: string; text: string | null; value?: string | null }>;
}

/**
 * Every item on a board, following Monday's cursor.
 *
 * PAGINATED, AND THE REASON MATTERS. `items_page` caps at 500 and returns the
 * OLDEST first, so a single unpaginated page does not merely miss the tail —
 * it misses the NEWEST items, which are exactly the episodes being published
 * this week. Bounded at 20 pages (10,000 items) so a cursor that never
 * terminates cannot spin an invocation to death.
 */
export async function fetchAllItems(
  boardId: string,
  columnIds: string[],
): Promise<RawItem[]> {
  const query = `
    query ($ids: [ID!], $columns: [String!], $cursor: String) {
      boards (ids: $ids) {
        items_page (limit: 500, cursor: $cursor) {
          cursor
          items {
            id
            name
            created_at
            column_values (ids: $columns) { id text value }
          }
        }
      }
    }`;

  const items: RawItem[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 20; page++) {
    const data: {
      boards: Array<{
        items_page: { cursor: string | null; items: RawItem[] };
      }> | null;
    } = await gql(query, { ids: [boardId], columns: columnIds, cursor });

    const chunk = data.boards?.[0]?.items_page;
    if (!chunk) break;

    items.push(...chunk.items);
    cursor = chunk.cursor;
    if (!cursor) break;
  }

  return items;
}

export interface PublishingItem {
  id: string;
  name: string;
  ep: string;
  /** `YYYY-MM-DD` from the Date column's JSON value, or "" when unset. */
  date: string;
  /**
   * The status column's `index` field — which is the LABEL ID, not the display
   * position (see the note in config/monday.ts). Null when blank. Compare
   * with `MONDAY.publishingStatus`.
   */
  statusIndex: number | null;
  /** Type label id; null (blank) means Video — the pre-2026-09-05 items carry no Type. */
  typeIndex: number | null;
  coverStatusIndex: number | null;
  factoryIndex: number | null;
  ttPostId: string;
  igPostId: string;
  ytPostId: string;
  fbPostId: string;
}

/** The label index inside a status column's JSON value, or null when blank. */
function statusIndexOf(value: string | null | undefined): number | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { index?: number | null };
    return typeof parsed.index === "number" ? parsed.index : null;
  } catch {
    return null;
  }
}

/**
 * `YYYY-MM-DD` from a date column's JSON value. The `text` field is rendered
 * in the account's display timezone and format; the value is the fact.
 */
function dateOf(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value) as { date?: string | null };
    return parsed.date ?? "";
  } catch {
    return "";
  }
}

/**
 * The Publishing board, as the app reads it.
 *
 * ONE QUERY, WHOLE BOARD, matched in memory. The board is one row per post-day
 * — a few hundred at most — so a full read costs less than Monday's
 * `items_page_by_column_values` would in API surface, and getting a server-side
 * filter subtly wrong would make every alert land on the fallback item.
 *
 * Status-type columns are read as INDEXES from the JSON value, never as label
 * text, for the same reason they are written that way.
 */
export async function listPublishingItems(): Promise<PublishingItem[]> {
  const c = MONDAY.publishingColumns;
  const items = await fetchAllItems(MONDAY.boards.publishing, [
    c.ep,
    c.date,
    c.status,
    c.type,
    c.coverStatus,
    c.factory,
    c.ttPostId,
    c.igPostId,
    c.ytPostId,
    c.fbPostId,
  ]);

  return items.map((item) => {
    const text: Record<string, string> = {};
    const value: Record<string, string | null> = {};
    for (const column of item.column_values) {
      text[column.id] = (column.text ?? "").trim();
      value[column.id] = column.value ?? null;
    }
    return {
      id: item.id,
      name: item.name,
      ep: text[c.ep] ?? "",
      date: dateOf(value[c.date]),
      statusIndex: statusIndexOf(value[c.status]),
      typeIndex: statusIndexOf(value[c.type]),
      coverStatusIndex: statusIndexOf(value[c.coverStatus]),
      factoryIndex: statusIndexOf(value[c.factory]),
      ttPostId: text[c.ttPostId] ?? "",
      igPostId: text[c.igPostId] ?? "",
      ytPostId: text[c.ytPostId] ?? "",
      fbPostId: text[c.fbPostId] ?? "",
    };
  });
}

/** The Video item for an episode (Text items share the EP value and end in "(text)"). */
export function videoItemFor(items: PublishingItem[], ep: string): PublishingItem | null {
  const matches = items.filter((item) => item.ep.toLowerCase() === ep.toLowerCase());
  return (
    matches.find((item) => item.typeIndex !== MONDAY.publishingType.text) ??
    matches[0] ??
    null
  );
}

// ---------------------------------------------------------------------------
// The one column this app writes: Factory (spec 16 §6, 2026-10-17)
// ---------------------------------------------------------------------------

/**
 * Sets the Factory column on one Publishing item and READS IT BACK.
 *
 * Output only, by index. Pausha's requirement (2026-10-17): "all actions that
 * happen automatically are still reflected in Monday boards … so I can see
 * what's happening." A write that is accepted and keeps nothing is the
 * failure this house has met before, so the value is read back and a
 * mismatch is returned as an error rather than reported as done.
 *
 * NEVER THROWS: a board write must not fail the run that earned it. The caller
 * logs the outcome; the next tick writes it again.
 */
export async function setFactory(
  itemId: string,
  label: FactoryLabel,
): Promise<{ ok: boolean; error?: string }> {
  const index = MONDAY.factory[label];
  const column = MONDAY.publishingColumns.factory;
  try {
    await updateItem(MONDAY.boards.publishing, itemId, { [column]: statusValue(index) });
    const data = await gql<{
      items: Array<{ column_values: Array<{ id: string; value: string | null }> }> | null;
    }>(
      `query ($ids: [ID!], $columns: [String!]) {
         items (ids: $ids) { column_values (ids: $columns) { id value } }
       }`,
      { ids: [itemId], columns: [column] },
    );
    const back = statusIndexOf(data.items?.[0]?.column_values?.[0]?.value);
    if (back !== index) {
      return { ok: false, error: `Factory write did not read back (wanted ${index}, got ${back ?? "blank"})` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The Publishing item for an episode, or null.
 *
 * Returned rather than thrown on any failure: this is called on the way to an
 * alert, and a Monday hiccup must not stop the alert — it just lands on the
 * fallback item instead.
 */
export async function findPublishingItemId(ep: string): Promise<string | null> {
  try {
    const items = await listPublishingItems();
    const match = items.find((item) => item.ep.toLowerCase() === ep.toLowerCase());
    return match?.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Notifications — the alert channel
// ---------------------------------------------------------------------------

/**
 * The token owner's user id, resolved once per process.
 *
 * `create_notification` needs a `user_id`, and the only user this app should
 * ever notify is whoever owns the token. Cached in-process rather than in
 * config so rotating the token to a different person needs no code change.
 */
let cachedUserId: string | null = null;

export async function currentUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;
  const data = await gql<{ me: { id: string } | null }>(`query { me { id } }`);
  if (!data.me?.id) throw new MondayError("Monday `me` returned no id");
  cachedUserId = data.me.id;
  return cachedUserId;
}

/**
 * Sends one notification, aimed at an item.
 *
 * NEVER THROWS. An alert that fails to send must not fail the run that raised
 * it — the failure being reported is more important than the report. The
 * caller records the outcome; the alerts table keeps the condition open so a
 * later tick tries again.
 *
 * `targetItemId` falls back to `MONDAY_ALERT_ITEM_ID` when the episode is not
 * known. With neither there is nowhere to deliver, which is returned as an
 * error rather than swallowed, so /status can show the red line.
 */
export async function notify(
  text: string,
  targetItemId?: string | null,
): Promise<{ sent: boolean; error?: string; targetId?: string }> {
  const targetId = targetItemId ?? alertFallbackItemId();
  if (!targetId) {
    return {
      sent: false,
      error: `no target item: set ${MONDAY.alertFallbackItemEnv}`,
    };
  }

  try {
    const userId = await currentUserId();
    await gql(
      `mutation ($userId: ID!, $targetId: ID!, $text: String!, $targetType: NotificationTargetType!) {
         create_notification (
           user_id: $userId,
           target_id: $targetId,
           text: $text,
           target_type: $targetType
         ) { text }
       }`,
      {
        userId,
        targetId,
        text: text.slice(0, 2000),
        targetType: MONDAY.notificationTargetType,
      },
    );
    return { sent: true, targetId };
  } catch (error) {
    return {
      sent: false,
      targetId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function mondayConfigured(): boolean {
  return Boolean(process.env.MONDAY_API_TOKEN);
}

// ---------------------------------------------------------------------------
// Board verification
// ---------------------------------------------------------------------------

export interface BoardCheck {
  ok: boolean;
  boardName: string | null;
  missingColumns: string[];
  error: string | null;
}

/**
 * Confirms every configured column still exists on a board.
 *
 * A write to a column id that is no longer on the board is accepted by the
 * API and keeps nothing; a read of one returns blanks that look like an empty
 * board. The status page turns that into one red line. Phase 1 checks the
 * Publishing board; the signature takes any board + column map so Phase 2 can
 * check Video Performance the same way.
 */
export async function checkBoard(
  boardId: string = MONDAY.boards.publishing,
  columns: Record<string, string> = MONDAY.publishingColumns,
): Promise<BoardCheck> {
  try {
    const data = await gql<{
      boards: Array<{
        id: string;
        name: string;
        columns: Array<{ id: string; title: string }>;
      }> | null;
    }>(
      `query ($ids: [ID!]) {
         boards (ids: $ids) {
           id
           name
           columns { id title }
         }
       }`,
      { ids: [boardId] },
    );

    const board = data.boards?.[0];
    if (!board) {
      return {
        ok: false,
        boardName: null,
        missingColumns: [],
        error: `Board ${boardId} not found, or the token cannot see it.`,
      };
    }

    const columnIds = new Set(board.columns.map((c) => c.id));
    const missingColumns = Object.entries(columns)
      .filter(([, id]) => !columnIds.has(id))
      .map(([name, id]) => `${name} (${id})`);

    return {
      ok: missingColumns.length === 0,
      boardName: board.name,
      missingColumns,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      boardName: null,
      missingColumns: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
