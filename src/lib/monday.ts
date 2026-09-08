import { MONDAY, alertFallbackItemId } from "@/config/monday";

/**
 * Monday GraphQL client.
 *
 * COPIED FROM PHOTO-PUBLISHER AND CUT DOWN. Phase 1 needs three things from
 * Monday: find the Publishing item for an episode, verify the board still has
 * the columns config says it has, and deliver notifications — because in this
 * house alerts are Monday notifications and nothing else. No column is
 * written in Phase 1; the helpers that would write one (`statusValue`,
 * `updateItem`) are kept so Phase 2 does not reinvent them, and status columns
 * are written by INDEX, never label, because label text is editable on the
 * board and a rename would silently stop every write.
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

/** Status columns are written as `{ index }`, never `{ label }`. */
export function statusValue(index: number): { index: number } {
  return { index };
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
  ytPostId: string;
}

/**
 * The Publishing board, reduced to what episode lookup needs.
 *
 * ONE QUERY, WHOLE BOARD, matched in memory. The board is one row per episode
 * — a few hundred at most — so a full read costs less than Monday's
 * `items_page_by_column_values` would in API surface, and getting a server-side
 * filter subtly wrong would make every alert land on the fallback item.
 */
export async function listPublishingItems(): Promise<PublishingItem[]> {
  const c = MONDAY.publishingColumns;
  const items = await fetchAllItems(MONDAY.boards.publishing, [c.ep, c.ytPostId]);

  return items.map((item) => {
    const text: Record<string, string> = {};
    for (const column of item.column_values) text[column.id] = (column.text ?? "").trim();
    return {
      id: item.id,
      name: item.name,
      ep: text[c.ep] ?? "",
      ytPostId: text[c.ytPostId] ?? "",
    };
  });
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
