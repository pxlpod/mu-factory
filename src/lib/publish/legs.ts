import { createHash } from "node:crypto";

import { PUBLISH_SLOTS } from "@/config/factory";
import { MONDAY } from "@/config/monday";
import { PUBLISH, TEXT_LEGS, VIDEO_LEGS, type LegSpec } from "@/config/publish";
import { ZERNIO } from "@/config/zernio";
import type { PublishingItem } from "@/lib/monday";
import { legInstant, wallClock } from "@/lib/slots";
import type { CreatePostInput } from "@/lib/zernio/client";

/**
 * From a Publishing item to the Zernio posts it means.
 *
 * THE BOARD IS THE COPY OF RECORD (doc 13 truth laws; doc 12, 2026-09-11:
 * "Claude builds the week's job FROM THE BOARD copy"). Nothing here invents
 * text: YT title / YT description / TikTok caption / IG-FB caption are read
 * from the item; the Facebook reel reuses the IG-FB caption and the YT title
 * (`mu_post.py` fallbacks, which is all the board has ever carried); stories
 * carry the episode's question; the text lane's body IS the IG-FB caption
 * column of the Text item. The disclosure line is appended to every Facebook
 * post, idempotently, and never typed into the board.
 *
 * `copyHash` is what the reconcile step compares against the board on every
 * tick: content + settings + slot. A difference means the human changed
 * something after the hand-off, and the post is cancelled and re-made.
 */

export interface PlannedLeg {
  spec: LegSpec;
  slotAt: Date;
  /** Everything but the media URL, which is known only after upload. */
  draft: Omit<CreatePostInput, "mediaUrl">;
  copyHash: string;
}

export function isTextItem(item: PublishingItem): boolean {
  return item.typeIndex === MONDAY.publishingType.text;
}

export function legsFor(item: PublishingItem): readonly LegSpec[] {
  return isTextItem(item) ? TEXT_LEGS : VIDEO_LEGS;
}

/** What a leg will be told to post, or a reason it cannot be built yet. */
export function planLeg(
  item: PublishingItem,
  spec: LegSpec,
  episode: { question: string | null },
  tailCoverMs: number | null,
  coverIgUrl: string | null,
): { ok: true; leg: PlannedLeg } | { ok: false; reason: string } {
  const slot = isTextItem(item) ? PUBLISH_SLOTS.text : PUBLISH_SLOTS.video;
  const slotAt = legInstant(item.date, slot, spec.offsetMinutes);
  const scheduledFor = wallClock(slotAt, PUBLISH.timezone);
  const metadata = { episode: item.ep, kind: spec.kind, source: PUBLISH.metadataSource };
  const accountId = ZERNIO.accountIds[spec.platform];

  let content: string;
  let platformSpecificData: Record<string, unknown> | undefined;
  let tiktokSettings: Record<string, unknown> | undefined;

  switch (`${spec.platform}:${spec.kind}`) {
    case "tiktok:video": {
      if (!item.ttCaption) return { ok: false, reason: "TikTok caption is empty on the item" };
      if (tailCoverMs === null) return { ok: false, reason: "tail-card sidecar (cover_ms) not read" };
      content = item.ttCaption;
      // The tail card; NO image url (it overrides the timestamp and gets dropped — doc 12, 2026-09-10).
      const settings = { ...PUBLISH.tiktok, video_cover_timestamp_ms: tailCoverMs };
      platformSpecificData = settings;
      tiktokSettings = settings;
      break;
    }
    case "instagram:video": {
      if (!item.igFbCaption) return { ok: false, reason: "IG / FB caption is empty on the item" };
      if (!coverIgUrl) return { ok: false, reason: "IG cover not uploaded" };
      content = item.igFbCaption;
      platformSpecificData = { instagramThumbnail: coverIgUrl };
      break;
    }
    case "youtube:video": {
      if (!item.ytTitle) return { ok: false, reason: "YT title is empty on the item" };
      if (!item.ytDescription) return { ok: false, reason: "YT description is empty on the item" };
      content = item.ytDescription;
      platformSpecificData = { ...PUBLISH.youtube, title: item.ytTitle.slice(0, PUBLISH.titleMaxChars) };
      break;
    }
    case "facebook:video": {
      if (!item.igFbCaption) return { ok: false, reason: "IG / FB caption is empty on the item" };
      if (!item.ytTitle) return { ok: false, reason: "YT title is empty on the item (the reel's title)" };
      content = withDisclosure(item.igFbCaption);
      platformSpecificData = { ...PUBLISH.facebookReel, title: item.ytTitle.slice(0, PUBLISH.titleMaxChars) };
      break;
    }
    case "instagram:story":
    case "facebook:story": {
      content = episode.question?.trim() || item.igFbCaption;
      if (!content) return { ok: false, reason: "no question or caption for the story" };
      platformSpecificData = { ...PUBLISH.story };
      break;
    }
    case "facebook:text": {
      if (!item.igFbCaption) return { ok: false, reason: "IG / FB caption (the post body) is empty on the Text item" };
      content = withDisclosure(item.igFbCaption);
      break;
    }
    default:
      return { ok: false, reason: `no recipe for ${spec.platform}:${spec.kind}` };
  }

  const draft: Omit<CreatePostInput, "mediaUrl"> = {
    content,
    mediaType: spec.mediaType,
    platform: spec.platform,
    accountId,
    platformSpecificData,
    tiktokSettings,
    scheduledFor,
    timezone: PUBLISH.timezone,
    metadata,
  };

  // The hash covers what a human can change on the board (copy, title, date),
  // not what the machine derives (media URLs, the tail card's timestamp),
  // which rotate on re-upload and would make every tick look like an edit.
  const copyHash = hashOf({
    platform: spec.platform,
    kind: spec.kind,
    content,
    title: (platformSpecificData?.title as string | undefined) ?? null,
    scheduledFor,
  });

  return { ok: true, leg: { spec, slotAt, draft, copyHash } };
}

/** The Facebook caption rule: the disclosure line once, never twice. */
export function withDisclosure(text: string): string {
  const trimmed = (text ?? "").trimEnd();
  return trimmed.includes(PUBLISH.facebookDisclosure)
    ? trimmed
    : `${trimmed}\n\n${PUBLISH.facebookDisclosure}`;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
