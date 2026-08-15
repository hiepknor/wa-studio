import { useState } from "react";

import { Tabs } from "@/shared/ui/Tabs";
import { GroupsScreen } from "./GroupsScreen";
import { SavedGroupListsPanel } from "./SavedGroupListsPanel";

type GroupsTab = "all" | "saved";

export function GroupsWorkspace() {
  const [activeTab, setActiveTab] = useState<GroupsTab>("all");
  const navigation = (
    <Tabs
      activeTab={activeTab}
      ariaLabel="Groups views"
      idPrefix="groups-workspace"
      onChange={setActiveTab}
      tabs={[
        { id: "all", label: "All groups" },
        { id: "saved", label: "Saved lists" },
      ]}
    />
  );

  return activeTab === "all"
    ? <GroupsScreen navigation={navigation} />
    : <SavedGroupListsPanel navigation={navigation} />;
}
