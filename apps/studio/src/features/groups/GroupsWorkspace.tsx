import { useState } from "react";

import { Tabs } from "@/shared/ui/Tabs";
import { GroupsScreen } from "./GroupsScreen";
import { GroupListsPanel } from "./GroupListsPanel";

type GroupsTab = "all" | "lists";

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
        { id: "lists", label: "Group lists" },
      ]}
    />
  );

  return activeTab === "all"
    ? <GroupsScreen navigation={navigation} />
    : <GroupListsPanel navigation={navigation} />;
}
