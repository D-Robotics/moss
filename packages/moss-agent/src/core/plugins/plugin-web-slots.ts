/** Stable browser extension slots available to trusted runtime plugins. @beta */
export const MOSS_WEB_SLOTS = [
  'navigation.primary',
  'navigation.session',
  'navigation.footer',
  'conversation.header',
  'conversation.message',
  'conversation.composer',
  'conversation.details',
  'tool.inline',
  'tool.details',
  'settings.section',
  'settings.plugin',
] as const;

/** Stable browser extension slot available to trusted runtime plugins. @beta */
export type MossWebSlot = (typeof MOSS_WEB_SLOTS)[number];
