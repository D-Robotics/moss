import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import './app-frame.css';

const LAYOUT_STORAGE_KEY = 'moss-layout-v1';
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 252;
const SIDEBAR_RAIL = 64;
const DETAILS_MIN = 280;
const DETAILS_MAX = 520;
const DETAILS_DEFAULT = 320;
const CENTER_MIN = 560;
const NARROW_BREAKPOINT = 1080;
const MOBILE_BREAKPOINT = 780;

interface LayoutPreferences {
  sidebarWidth: number;
  detailsWidth: number;
  sidebarOpen: boolean;
  detailsOpen: boolean;
  narrowSidebarExpanded: boolean;
}

export interface MossLayoutController extends LayoutPreferences {
  mobileSidebarOpen: boolean;
  mobileDetailsOpen: boolean;
  setSidebarWidth(width: number): void;
  setDetailsWidth(width: number): void;
  toggleSidebar(): void;
  toggleDetails(): void;
  openDetails(): void;
  closeDetails(): void;
  closeDrawers(): void;
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, Math.round(value)));

const defaultPreferences: LayoutPreferences = {
  sidebarWidth: SIDEBAR_DEFAULT,
  detailsWidth: DETAILS_DEFAULT,
  sidebarOpen: true,
  detailsOpen: true,
  narrowSidebarExpanded: false,
};

const readPreferences = (): LayoutPreferences => {
  try {
    const value = JSON.parse(
      localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}'
    ) as Partial<LayoutPreferences>;
    return {
      sidebarWidth: clamp(value.sidebarWidth ?? SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX),
      detailsWidth: clamp(value.detailsWidth ?? DETAILS_DEFAULT, DETAILS_MIN, DETAILS_MAX),
      sidebarOpen: value.sidebarOpen ?? true,
      detailsOpen: value.detailsOpen ?? true,
      narrowSidebarExpanded: value.narrowSidebarExpanded ?? false,
    };
  } catch {
    return defaultPreferences;
  }
};

const isMobileViewport = () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;

export const useMossLayout = (): MossLayoutController => {
  const [preferences, setPreferences] = useState(readPreferences);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // A privacy-restricted browser may deny storage; the live layout remains usable.
    }
  }, [preferences]);
  return {
    ...preferences,
    mobileSidebarOpen,
    mobileDetailsOpen,
    setSidebarWidth: (sidebarWidth) =>
      setPreferences((current) => ({
        ...current,
        sidebarWidth: clamp(sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX),
      })),
    setDetailsWidth: (detailsWidth) =>
      setPreferences((current) => ({
        ...current,
        detailsWidth: clamp(detailsWidth, DETAILS_MIN, DETAILS_MAX),
      })),
    toggleSidebar: () => {
      if (isMobileViewport()) setMobileSidebarOpen((current) => !current);
      else if (window.matchMedia(`(max-width: ${NARROW_BREAKPOINT}px)`).matches)
        setPreferences((current) => ({
          ...current,
          narrowSidebarExpanded: !current.narrowSidebarExpanded,
        }));
      else setPreferences((current) => ({ ...current, sidebarOpen: !current.sidebarOpen }));
    },
    toggleDetails: () => {
      if (isMobileViewport()) setMobileDetailsOpen((current) => !current);
      else setPreferences((current) => ({ ...current, detailsOpen: !current.detailsOpen }));
    },
    openDetails: () => {
      if (isMobileViewport()) setMobileDetailsOpen(true);
      else setPreferences((current) => ({ ...current, detailsOpen: true }));
    },
    closeDetails: () => {
      if (isMobileViewport()) setMobileDetailsOpen(false);
      else setPreferences((current) => ({ ...current, detailsOpen: false }));
    },
    closeDrawers: () => {
      setMobileSidebarOpen(false);
      setMobileDetailsOpen(false);
    },
  };
};

interface ResolvedLayout {
  sidebar: number;
  details: number;
  narrow: boolean;
  mobile: boolean;
}

const resolveLayout = (viewport: number, preferences: LayoutPreferences): ResolvedLayout => {
  const mobile = viewport <= MOBILE_BREAKPOINT;
  const narrow = viewport <= NARROW_BREAKPOINT;
  if (mobile) return { sidebar: 0, details: 0, narrow, mobile };
  const sidebar =
    !preferences.sidebarOpen || (narrow && !preferences.narrowSidebarExpanded)
      ? SIDEBAR_RAIL
      : preferences.sidebarWidth;
  if (!preferences.detailsOpen) return { sidebar, details: 0, narrow, mobile };
  const preferredCenter = viewport - sidebar - preferences.detailsWidth;
  if (preferredCenter >= CENTER_MIN) {
    return { sidebar, details: preferences.detailsWidth, narrow, mobile };
  }
  const conceded = viewport - sidebar - CENTER_MIN;
  return {
    sidebar,
    details: conceded >= DETAILS_MIN ? clamp(conceded, DETAILS_MIN, preferences.detailsWidth) : 0,
    narrow,
    mobile,
  };
};

const ResizeHandle = ({
  side,
  position,
  onResize,
}: {
  side: 'sidebar' | 'details';
  position: number;
  onResize(delta: number): void;
}) => {
  const currentWidth = side === 'sidebar' ? position : window.innerWidth - position;
  const minimum = side === 'sidebar' ? SIDEBAR_MIN : DETAILS_MIN;
  const maximum = side === 'sidebar' ? SIDEBAR_MAX : DETAILS_MAX;
  const origin = useRef(0);
  const latest = useRef(0);
  const frame = useRef<number | undefined>(undefined);
  const startWidth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const emit = useCallback(() => {
    frame.current = undefined;
    onResize(
      startWidth.current +
        (side === 'sidebar' ? latest.current - origin.current : origin.current - latest.current)
    );
  }, [onResize, side]);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = event.clientX;
    latest.current = event.clientX;
    startWidth.current = side === 'sidebar' ? position : window.innerWidth - position;
    document.documentElement.dataset.mossResizing = side;
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    latest.current = event.clientX;
    frame.current ??= requestAnimationFrame(emit);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    latest.current = event.clientX;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    emit();
    delete document.documentElement.dataset.mossResizing;
    setDragging(false);
  };
  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      delete document.documentElement.dataset.mossResizing;
    },
    []
  );
  return (
    <div
      className="moss-resize-handle"
      data-resize-handle={side}
      data-dragging={dragging || undefined}
      role="separator"
      aria-label={`Resize ${side} panel`}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={Math.round(currentWidth)}
      aria-valuetext={`${Math.round(currentWidth)} pixels`}
      tabIndex={0}
      style={{ left: position }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        onResize(
          (side === 'sidebar' ? position : window.innerWidth - position) +
            direction * 16 * (side === 'sidebar' ? 1 : -1)
        );
      }}
    />
  );
};

export const AppFrame = ({
  layout,
  sidebar,
  conversation,
  details,
}: {
  layout: MossLayoutController;
  sidebar: ReactNode;
  conversation: ReactNode;
  details: ReactNode;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const sidebarDrawerRef = useRef<HTMLDivElement>(null);
  const detailsDrawerRef = useRef<HTMLDivElement>(null);
  const closeDrawersRef = useRef(layout.closeDrawers);
  closeDrawersRef.current = layout.closeDrawers;
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry?.contentRect.width) setViewport(entry.contentRect.width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const resolved = resolveLayout(viewport, layout);
  const drawerOpen = layout.mobileSidebarOpen || layout.mobileDetailsOpen;
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activeDrawer = layout.mobileSidebarOpen
      ? sidebarDrawerRef.current
      : detailsDrawerRef.current;
    const focusable = () => [
      ...(activeDrawer?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      ) ?? []),
    ];
    requestAnimationFrame(() => focusable()[0]?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawersRef.current();
      if (event.key !== 'Tab') return;
      const controls = focusable();
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      requestAnimationFrame(() => previous?.focus());
    };
  }, [drawerOpen, layout.mobileDetailsOpen, layout.mobileSidebarOpen]);
  return (
    <div
      ref={rootRef}
      className="app-frame"
      data-mobile={resolved.mobile || undefined}
      data-narrow={resolved.narrow || undefined}
      data-sidebar-collapsed={resolved.sidebar === SIDEBAR_RAIL || undefined}
      data-details-collapsed={resolved.details === 0 || undefined}
      style={
        {
          '--moss-layout-sidebar': `${resolved.sidebar}px`,
          '--moss-layout-details': `${resolved.details}px`,
        } as React.CSSProperties
      }
    >
      <a className="moss-skip-link" href="#moss-main-content">
        Skip to conversation
      </a>
      <div
        ref={sidebarDrawerRef}
        className="moss-sidebar-column"
        data-mobile-drawer="sidebar"
        data-open={layout.mobileSidebarOpen || undefined}
        role={resolved.mobile ? 'dialog' : undefined}
        aria-modal={resolved.mobile && layout.mobileSidebarOpen ? 'true' : undefined}
        aria-label={resolved.mobile ? 'Navigation panel' : undefined}
        aria-hidden={resolved.mobile && !layout.mobileSidebarOpen ? 'true' : undefined}
        inert={resolved.mobile && !layout.mobileSidebarOpen ? true : undefined}
      >
        {sidebar}
      </div>
      <div
        className="moss-conversation-column"
        id="moss-main-content"
        tabIndex={-1}
        inert={drawerOpen ? true : undefined}
      >
        {conversation}
      </div>
      <div
        ref={detailsDrawerRef}
        className="moss-details-column"
        data-mobile-drawer="details"
        data-open={layout.mobileDetailsOpen || undefined}
        role={resolved.mobile ? 'dialog' : undefined}
        aria-modal={resolved.mobile && layout.mobileDetailsOpen ? 'true' : undefined}
        aria-label={resolved.mobile ? 'Task details panel' : undefined}
        aria-hidden={resolved.mobile && !layout.mobileDetailsOpen ? 'true' : undefined}
        inert={resolved.mobile && !layout.mobileDetailsOpen ? true : undefined}
      >
        {details}
      </div>
      {drawerOpen && (
        <button
          type="button"
          className="moss-drawer-backdrop"
          aria-label="Close open panel"
          onClick={layout.closeDrawers}
        />
      )}
      {!resolved.mobile && resolved.sidebar > SIDEBAR_RAIL && (
        <ResizeHandle
          side="sidebar"
          position={resolved.sidebar}
          onResize={layout.setSidebarWidth}
        />
      )}
      {!resolved.mobile && resolved.details > 0 && (
        <ResizeHandle
          side="details"
          position={viewport - resolved.details}
          onResize={layout.setDetailsWidth}
        />
      )}
    </div>
  );
};
