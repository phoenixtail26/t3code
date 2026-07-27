// Fork-owned aggregate mount: every fork pill in the sidebar footer renders
// through this single component so upstream files carry exactly one fork line.
// Add new fork pills here, not in SidebarChrome.tsx.
import { SidebarClaudeUsagePill } from "./SidebarClaudeUsagePill";
import { SidebarNewBuildPill } from "./SidebarNewBuildPill";

export function ForkSidebarPills() {
  return (
    <>
      <SidebarNewBuildPill />
      <SidebarClaudeUsagePill />
    </>
  );
}
