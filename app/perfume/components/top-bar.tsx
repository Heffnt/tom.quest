"use client";

// The /perfume TOP BAR (DESIGN.md §4 "Top bar" + §4 "Ownership, handoff, copy").
// Replaces the old components/tabs.tsx brew row with the full multi-brew index.
//
// Layout, left→right:
//   [party group] [you group] [other member groups…]              [settings ⚙]
//
// Each MEMBER GROUP shows:
//   • an avatar (uploaded icon → color+initial fallback) with an activity dot
//   • up to 5 most-recent brew chips (BrewIndex already caps recent at 5)
//   • a 'see all' overflow popover when the member has more than are shown
//   • a '+' create affordance on YOUR OWN group only
//
// The PARTY brew is a first-class chip in its own group (no owner, no '+').
// The ACTIVE brew chip is highlighted. Any member may rename any brew inline.
// The open brew gets a deep-link copy affordance and a small context menu
// (handoff / copy / delete) gated by permissions.
//
// This component is presentation + local menu state only; every mutation is a
// prop the orchestrator wires to BrewActions. Feel classes come from ./ui.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { BrewIndex, BrewSummary, MemberInfo } from "../lib/brew-types";
import { PARTY_KEY } from "../lib/brew-store";
import { btn, cn, tab } from "./ui";
import { Popover } from "./popover";

// ── props ─────────────────────────────────────────────────────────────────────

export type TopBarActions = {
  /** Open a brew on stage (a real brew id, or PARTY_KEY for the party brew). */
  onSelect: (brewKey: string) => void;
  /** Create a new brew (yours) and open it. */
  onCreate: () => void;
  /** Register the viewer as a member (click-to-join). */
  onJoin: () => void;
  /** Rename any brew (blank clears to the default name). */
  onNickname: (brewId: string, nickname: string) => void;
  /** Hand a brew you own to another member. */
  onHandoff: (brewId: string, toMemberKey: string) => void;
  /** Copy any brew into a new one you own. */
  onCopy: (brewId: string) => void;
  /** Delete a brew you own (or any, as admin). */
  onDelete: (brewId: string) => void;
};

export type TopBarPermissions = {
  registered: boolean;
  /** May rename any brew. */
  nickname: boolean;
  /** May handoff/delete the OPEN brew (owner or admin). */
  manageBrew: boolean;
  isAdmin: boolean;
};

export interface TopBarProps {
  index: BrewIndex | null;
  members: MemberInfo[];
  /** The brew currently on stage (a brew id, or PARTY_KEY). */
  activeKey: string | null;
  /** The viewer's member key, or null before identity resolves. */
  viewerKey: string | null;
  permissions: TopBarPermissions;
  actions: TopBarActions;
  /** The settings gear slot (rendered at the bar's right end). */
  settings?: ReactNode;
}

const PARTY_COLOR = "#C98A3C";

export default function TopBar({
  index,
  members,
  activeKey,
  viewerKey,
  permissions,
  actions,
  settings,
}: TopBarProps) {
  const memberByKey = new Map(members.map((m) => [m.memberKey, m]));

  // Party is its own group; the per-member groups follow (server orders them
  // you-first). The active-key match also accepts the party sentinel.
  const partyActive =
    activeKey === PARTY_KEY ||
    (index?.party != null && activeKey === index.party.brewId);

  return (
    <nav
      aria-label="Brews"
      className="flex items-center gap-3 overflow-x-auto border-b border-border px-3 py-1.5"
    >
      {index?.party && (
        <PartyGroup
          party={index.party}
          active={partyActive}
          activeKey={activeKey}
          viewerKey={viewerKey}
          members={members}
          permissions={permissions}
          actions={actions}
        />
      )}

      {index?.groups.map((g) => (
        <MemberGroup
          key={g.ownerKey}
          ownerKey={g.ownerKey}
          ownerName={g.ownerName}
          total={g.total}
          recent={g.recent}
          member={memberByKey.get(g.ownerKey) ?? null}
          you={g.ownerKey === viewerKey}
          activeKey={activeKey}
          viewerKey={viewerKey}
          members={members}
          permissions={permissions}
          actions={actions}
        />
      ))}

      <span className="ml-auto flex shrink-0 items-center gap-2">
        {!permissions.registered && (
          <button type="button" onClick={actions.onJoin} className={btn.accent}>
            join the party
          </button>
        )}
        {settings}
      </span>
    </nav>
  );
}

// ── the party group (first-class, no owner, no '+') ──────────────────────────

function PartyGroup({
  party,
  active,
  activeKey,
  viewerKey,
  members,
  permissions,
  actions,
}: {
  party: BrewSummary;
  active: boolean;
  activeKey: string | null;
  viewerKey: string | null;
  members: MemberInfo[];
  permissions: TopBarPermissions;
  actions: TopBarActions;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Avatar name="Party" color={PARTY_COLOR} fresh />
      <BrewChip
        brew={party}
        label={brewName(party, members)}
        color={PARTY_COLOR}
        active={active}
        isOpen={activeKey === PARTY_KEY || activeKey === party.brewId}
        viewerKey={viewerKey}
        members={members}
        permissions={permissions}
        actions={actions}
        // party opens via the sentinel so the store resolves the live id
        onOpen={() => actions.onSelect(PARTY_KEY)}
      />
    </span>
  );
}

// ── a member group ────────────────────────────────────────────────────────────

function MemberGroup({
  ownerKey,
  ownerName,
  total,
  recent,
  member,
  you,
  activeKey,
  viewerKey,
  members,
  permissions,
  actions,
}: {
  ownerKey: string;
  ownerName: string;
  total: number;
  recent: BrewSummary[];
  member: MemberInfo | null;
  you: boolean;
  activeKey: string | null;
  viewerKey: string | null;
  members: MemberInfo[];
  permissions: TopBarPermissions;
  actions: TopBarActions;
}) {
  const color = member?.color ?? "#6FE3C4";
  const overflow = total - recent.length;

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Avatar
        name={ownerName}
        color={color}
        fresh={member?.fresh ?? false}
        iconUrl={member?.iconUrl ?? null}
        badge={you ? "you" : undefined}
      />
      {recent.map((b) => (
        <BrewChip
          key={b.brewId}
          brew={b}
          label={brewName(b, members)}
          color={color}
          active={activeKey === b.brewId}
          isOpen={activeKey === b.brewId}
          viewerKey={viewerKey}
          members={members}
          permissions={permissions}
          actions={actions}
          onOpen={() => actions.onSelect(b.brewId)}
        />
      ))}

      {overflow > 0 && (
        <SeeAllPopover
          ownerKey={ownerKey}
          ownerName={ownerName}
          overflow={overflow}
          color={color}
          activeKey={activeKey}
          members={members}
          onSelect={actions.onSelect}
        />
      )}

      {you && permissions.registered && (
        <button
          type="button"
          onClick={actions.onCreate}
          aria-label="New brew"
          title="New brew"
          className={cn(btn.icon, "h-6 w-6 p-0 text-sm")}
        >
          +
        </button>
      )}
    </span>
  );
}

// ── an avatar + activity dot ──────────────────────────────────────────────────
// Renders the member's uploaded icon (listMembers resolves iconStorageId to a
// servable iconUrl server-side) when present; otherwise the color+initial
// fallback. The party group carries no icon, so it always shows the fallback.

function Avatar({
  name,
  color,
  fresh,
  iconUrl,
  badge,
}: {
  name: string;
  color: string;
  fresh: boolean;
  iconUrl?: string | null;
  badge?: string;
}) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className="relative flex shrink-0 items-center gap-1"
      title={fresh ? `${name} — active` : name}
    >
      <span
        aria-hidden="true"
        className="grid h-6 w-6 place-items-center overflow-hidden rounded-full border border-border font-mono text-[11px] font-semibold"
        style={{ background: `${color}22`, color }}
      >
        {iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={iconUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          initial
        )}
      </span>
      <span
        aria-hidden="true"
        className="absolute -bottom-0.5 left-[18px] h-2 w-2 rounded-full border border-bg"
        style={{
          background: fresh ? color : "#334155",
          boxShadow: fresh ? `0 0 6px ${color}` : undefined,
        }}
      />
      {badge && (
        <span className="font-mono text-[9px] uppercase tracking-wider text-text-faint">
          {badge}
        </span>
      )}
    </span>
  );
}

// ── a brew chip (open, rename, deep-link, context menu) ──────────────────────

function BrewChip({
  brew,
  label,
  color,
  active,
  isOpen,
  viewerKey,
  members,
  permissions,
  actions,
  onOpen,
}: {
  brew: BrewSummary;
  label: string;
  color: string;
  active: boolean;
  /** Whether this chip is the brew currently on stage (menu/deep-link shown). */
  isOpen: boolean;
  viewerKey: string | null;
  members: MemberInfo[];
  permissions: TopBarPermissions;
  actions: TopBarActions;
  onOpen: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  const openMenu = () => {
    const r = chipRef.current?.getBoundingClientRect();
    if (r) setMenuAt({ x: r.left, y: r.bottom + 4 });
  };

  if (renaming) {
    return (
      <NicknameField
        initial={brew.nickname ?? ""}
        placeholder={label}
        onCommit={(v) => {
          actions.onNickname(brew.brewId, v);
          setRenaming(false);
        }}
        onCancel={() => setRenaming(false)}
      />
    );
  }

  return (
    <span className="relative flex shrink-0 items-center">
      <button
        ref={chipRef}
        type="button"
        onClick={onOpen}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu();
        }}
        onDoubleClick={() => permissions.nickname && setRenaming(true)}
        aria-pressed={active}
        title={label}
        className={cn(tab.base, "gap-1.5", isOpen && "pr-1")}
      >
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: color }}
        />
        <span className="max-w-[140px] truncate">{label}</span>
        {brew.pinned && (
          <span aria-hidden="true" title="A recipe is pinned" className="text-accent">
            ★
          </span>
        )}
        {brew.cauldronCount > 0 && (
          <span
            aria-hidden="true"
            title={`${brew.cauldronCount} on the cauldron`}
            className="rounded-full bg-accent/20 px-1 text-[9px] leading-4 text-accent"
          >
            {brew.cauldronCount}
          </span>
        )}
      </button>

      {isOpen && (
        <button
          type="button"
          onClick={openMenu}
          aria-label="Brew menu"
          title="Brew actions"
          className={cn(btn.ghost, "ml-0.5 h-6 w-6 p-0 text-xs")}
        >
          ⋯
        </button>
      )}

      {menuAt && (
        <BrewMenu
          at={menuAt}
          brew={brew}
          viewerKey={viewerKey}
          members={members}
          permissions={permissions}
          actions={actions}
          onRename={() => setRenaming(true)}
          onClose={() => setMenuAt(null)}
        />
      )}
    </span>
  );
}

// ── inline nickname editor ────────────────────────────────────────────────────

function NicknameField({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        else if (e.key === "Escape") onCancel();
      }}
      placeholder={placeholder}
      maxLength={40}
      spellCheck={false}
      aria-label="Rename brew"
      className={cn(
        "w-[150px] shrink-0 rounded-md border border-accent/60 bg-bg px-2 py-1",
        "font-mono text-xs text-text placeholder:text-text-faint",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
      )}
    />
  );
}

// ── the brew context menu (handoff / copy / delete + deep link) ──────────────

function BrewMenu({
  at,
  brew,
  viewerKey,
  members,
  permissions,
  actions,
  onRename,
  onClose,
}: {
  at: { x: number; y: number };
  brew: BrewSummary;
  viewerKey: string | null;
  members: MemberInfo[];
  permissions: TopBarPermissions;
  actions: TopBarActions;
  onRename: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);

  const deepLink =
    typeof window !== "undefined"
      ? `${window.location.origin}/perfume/b/${brew.brewId}`
      : `/perfume/b/${brew.brewId}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(deepLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  // handoff targets: every OTHER member (never the current owner, never the party)
  const targets = members.filter((m) => m.memberKey !== brew.owner);
  const isParty = brew.owner === null;
  // Manage scope (handoff/delete) is per-BREW, not per-open-brew: the store's
  // permissions.manageBrew is scoped to the brew on stage, but a context menu can
  // be opened on any chip. Derive it locally from this brew's owner. The server
  // enforces regardless; this just keeps the affordances honest.
  const canManage =
    permissions.isAdmin || (viewerKey !== null && brew.owner === viewerKey);

  return (
    <Popover
      anchor={at}
      onClose={onClose}
      label="Brew actions"
      role="menu"
      className="min-w-[168px] p-1"
    >
      <MenuButton
        onClick={() => {
          void copyLink();
        }}
      >
        {copied ? "link copied ✓" : "copy deep link"}
      </MenuButton>

      {permissions.nickname && (
        <MenuButton
          onClick={() => {
            onRename();
            onClose();
          }}
        >
          rename…
        </MenuButton>
      )}

      {permissions.registered && (
        <MenuButton
          onClick={() => {
            actions.onCopy(brew.brewId);
            onClose();
          }}
        >
          copy this brew
        </MenuButton>
      )}

      {canManage && !isParty && targets.length > 0 && (
        <>
          <MenuButton onClick={() => setHandoffOpen((v) => !v)}>
            hand off to… {handoffOpen ? "▾" : "▸"}
          </MenuButton>
          {handoffOpen && (
            <div className="max-h-40 overflow-y-auto border-l border-border pl-1">
              {targets.map((m) => (
                <MenuButton
                  key={m.memberKey}
                  onClick={() => {
                    actions.onHandoff(brew.brewId, m.memberKey);
                    onClose();
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full"
                    style={{ background: m.color }}
                  />
                  {m.memberKey === viewerKey ? "you" : m.name}
                </MenuButton>
              ))}
            </div>
          )}
        </>
      )}

      {canManage && !isParty && (
        <MenuButton
          variant="danger"
          onClick={() => {
            actions.onDelete(brew.brewId);
            onClose();
          }}
        >
          delete brew
        </MenuButton>
      )}
    </Popover>
  );
}

// ── see-all overflow popover ──────────────────────────────────────────────────

function SeeAllPopover({
  ownerKey,
  ownerName,
  overflow,
  color,
  activeKey,
  members,
  onSelect,
}: {
  ownerKey: string;
  ownerName: string;
  overflow: number;
  color: string;
  activeKey: string | null;
  members: MemberInfo[];
  onSelect: (brewKey: string) => void;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  // The top-bar index carries only each member's 5 most-recent brews; the full
  // list (past the RECENT cap) loads lazily from listAllBrews when this opens.
  // Selecting any brew opens it on stage — the same path as a chip click.
  const all = useQuery(
    api.brews.listAllBrews,
    at ? { memberKey: ownerKey } : "skip",
  );
  const open = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setAt({ x: r.left, y: r.bottom + 4 });
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={open}
        aria-label={`See all ${ownerName}'s brews`}
        title={`${overflow} more`}
        className={cn(btn.ghost, "h-6 px-1.5 text-[10px]")}
      >
        +{overflow}
      </button>
      {at && (
        <Popover
          anchor={at}
          onClose={() => setAt(null)}
          label={`${ownerName}'s brews`}
          role="menu"
          className="min-w-[168px] p-1"
        >
          <p className="px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-text-faint">
            {ownerName} · {all ? all.length : overflow} brews
          </p>
          {all === undefined ? (
            <p className="px-2 pb-1.5 text-[11px] text-text-faint">loading…</p>
          ) : all.length === 0 ? (
            <p className="px-2 pb-1.5 text-[11px] text-text-faint">no brews</p>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              {all.map((b) => (
                <MenuButton
                  key={b.brewId}
                  onClick={() => {
                    onSelect(b.brewId);
                    setAt(null);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: color }}
                  />
                  <span
                    className={cn(
                      "truncate",
                      activeKey === b.brewId && "font-semibold text-accent",
                    )}
                  >
                    {brewName(b, members)}
                  </span>
                  {b.cauldronCount > 0 && (
                    <span className="ml-auto rounded-full bg-accent/20 px-1 text-[9px] leading-4 text-accent">
                      {b.cauldronCount}
                    </span>
                  )}
                </MenuButton>
              ))}
            </div>
          )}
        </Popover>
      )}
    </>
  );
}

function MenuButton({
  children,
  onClick,
  variant = "ghost",
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "ghost" | "danger";
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        variant === "danger" ? btn.danger : btn.ghost,
        "w-full justify-start px-2 py-1.5 text-left",
      )}
    >
      {children}
    </button>
  );
}

// ── default naming: "{owner} brew {n}" unless nicknamed ───────────────────────

function brewName(brew: BrewSummary, members: MemberInfo[]): string {
  if (brew.nickname) return brew.nickname;
  if (brew.owner === null) return "Party";
  const owner = members.find((m) => m.memberKey === brew.owner)?.name ?? brew.owner;
  return `${owner} brew ${brew.seq}`;
}
