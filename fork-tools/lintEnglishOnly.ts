// Fork-owned UI ships in English only, so `t3code/no-untranslated-copy` is off for these
// files. A fork line inside an upstream file still follows upstream's gt()/msg() convention.
export const forkEnglishOnlyFiles = [
  "apps/web/src/dictation/**",
  "apps/web/src/fork/**",
  "apps/web/src/readAloud/**",
  "apps/web/src/threadFork/**",
  "apps/web/src/components/settings/fork/**",
  "apps/web/src/components/ExternalSessionView.tsx",
  "apps/web/src/components/ExternalSessionView.logic.ts",
  "apps/web/src/components/ExternalSessionsSection.tsx",
  "apps/web/src/components/settings/NotificationSoundControl.tsx",
  "apps/web/src/components/sidebar/ForkSidebarPills.tsx",
  "apps/web/src/components/sidebar/SidebarNewBuildPill.tsx",
  "apps/web/src/components/sidebar/newBuildAvailable.logic.ts",
  "apps/web/src/hooks/useSidebarEdgeSwipe.ts",
  "apps/web/src/hooks/useUserPresenceReporter.ts",
  "apps/web/src/hooks/useWebPush.ts",
  "apps/web/src/lib/notificationSound.ts",
  "apps/web/src/lib/webPush.ts",
  "apps/web/src/routes/_chat.$environmentId.external.$sessionId.tsx",
  "apps/web/src/state/externalSessions.ts",
  "packages/client-runtime/src/state/externalSessions.ts",
];
