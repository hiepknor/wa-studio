import { useRef, useState } from "react";

import { AppIcon } from "../shared/ui/AppIcon";
import { Badge } from "../shared/ui/Badge";
import { BrandMark } from "../shared/ui/BrandMark";
import { Button } from "../shared/ui/Button";
import { Checkbox } from "../shared/ui/Checkbox";
import { ConfirmationDialog } from "../shared/ui/ConfirmationDialog";
import {
  ActionFooter,
  DataTableFrame,
  DescriptionList,
  EmptyState,
  EvidenceList,
  MetricGrid,
  SectionHeader,
  SurfacePanel,
} from "../shared/ui/Composition";
import {
  DataTable,
  DataTableScroll,
} from "../shared/ui/DataTable";
import { DataFilterToolbar } from "../shared/ui/DataFilterToolbar";
import { DateTime } from "../shared/ui/DateTime";
import { DecisionGroup } from "../shared/ui/DecisionGroup";
import { DataTablePrimaryAction } from "../shared/ui/DataTablePrimaryAction";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../shared/ui/DropdownMenu";
import { DrawerHost, DrawerProvider } from "../shared/ui/Drawer";
import { FilterOption } from "../shared/ui/FilterOption";
import { FilterChip } from "../shared/ui/FilterChip";
import { InlineAlert } from "../shared/ui/InlineAlert";
import {
  InspectorDisclosure,
  InspectorDrawer,
  InspectorSection,
} from "../shared/ui/InspectorDrawer";
import { ModalDialog } from "../shared/ui/ModalDialog";
import { PageHeader } from "../shared/ui/PageHeader";
import { SearchField } from "../shared/ui/SearchField";
import { SearchSelect } from "../shared/ui/SearchSelect";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { SelectMenu } from "../shared/ui/SelectMenu";
import { StatusDot } from "../shared/ui/StatusDot";
import { SwitchField } from "../shared/ui/SwitchField";
import { TablePagination } from "../shared/ui/TablePagination";
import { Tabs } from "../shared/ui/Tabs";
import { TextAreaField } from "../shared/ui/TextAreaField";
import { TextField } from "../shared/ui/TextField";
import { useToast } from "../shared/ui/Toast";
import { WorkspaceDialog } from "../shared/ui/WorkspaceDialog";
import { WorkflowStepper } from "../shared/ui/WorkflowStepper";
import {
  designSystemStateNames,
  type DesignSystemComponentName,
} from "./design-system-state-matrix";

type Tab = "overview" | "members";
type Step = "content" | "targets" | "review";
type Schedule = "immediate" | "once";
type Mode = "dry" | "live";

const selectOptions = [
  { description: "Begin when a run is created.", label: "Immediate", value: "immediate" },
  { description: "Begin at one saved timestamp.", label: "Once", value: "once" },
] as const;

const sessionOptions = [
  { group: "Ready", keywords: "production north america", label: "North America operations", value: "north" },
  { group: "Ready", keywords: "sales", label: "Sales session", value: "sales" },
  { disabled: true, group: "Unavailable", label: "Archived session", value: "archived" },
] as const;

function GalleryToastDemo() {
  const toast = useToast();
  return <Button
    onClick={() => toast.notify({
      description: "The latest capability result is now visible.",
      title: "Capability updated",
      tone: "success",
    })}
  >Show toast</Button>;
}

function Specimen({ children, description, title }: {
  children: React.ReactNode;
  description: string;
  title: string;
}) {
  return <section className="ds-specimen">
    <header><h3>{title}</h3><p>{description}</p></header>
    <div className="ds-specimen-stage">{children}</div>
  </section>;
}

function StateBoundary({ children, component }: {
  children: React.ReactNode;
  component: DesignSystemComponentName;
}) {
  return (
    <div
      className="ds-state-boundary"
      data-ds-component={component}
      data-ds-states={designSystemStateNames(component)}
    >
      {children}
    </div>
  );
}

function GalleryDrawerDemo() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DrawerProvider className="ds-gallery-drawer-frame">
      <Button onClick={() => setOpen(true)} ref={triggerRef}>Open drawer</Button>
      <DrawerHost />
      <InspectorDrawer
        footer={(
          <ActionFooter
            actions={<Button onClick={() => setOpen(false)}>Done</Button>}
            description="Actions remain visible while evidence scrolls."
            title="Runtime authoritative"
          />
        )}
        kicker="Runtime evidence"
        meta={["Run 12345678", "Dry run"]}
        onClose={() => setOpen(false)}
        open={open}
        returnFocusRef={triggerRef}
        size="standard"
        status={<Badge tone="info" variant="status">Running</Badge>}
        title="Product release"
      >
        <InspectorSection
          description="The primary facts stay scannable at compact and expanded widths."
          eyebrow="Overview"
          title="Run summary"
          titleId="gallery-inspector-summary-title"
        >
          <MetricGrid ariaLabel="Run summary" items={[
            { label: "Targets", value: "71" },
            { label: "Advanced", tone: "success", value: "64" },
          ]} />
        </InspectorSection>
        <InspectorDisclosure
          title="Technical evidence"
          titleId="gallery-inspector-evidence-title"
        >
          <DescriptionList ariaLabel="Technical evidence" items={[
            { id: "policy", label: "Policy", value: "safety-v4", valueClassName: "data-identifier" },
            { id: "revision", label: "Revision", value: "r3", valueClassName: "data-identifier" },
          ]} />
        </InspectorDisclosure>
      </InspectorDrawer>
    </DrawerProvider>
  );
}

function GalleryTabPanel({ active, children, idPrefix, itemId }: {
  active: boolean;
  children: React.ReactNode;
  idPrefix: string;
  itemId: string;
}) {
  return <div
    aria-labelledby={`${idPrefix}-${itemId}-tab`}
    className="ds-visually-hidden"
    hidden={!active}
    id={`${idPrefix}-${itemId}-panel`}
    role="tabpanel"
  >{children}</div>;
}

export function DesignSystemGallery() {
  const [schedule, setSchedule] = useState<Schedule>("immediate");
  const [session, setSession] = useState("north");
  const [mode, setMode] = useState<Mode>("dry");
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [activeStep, setActiveStep] = useState<Step>("review");
  const [switchOn, setSwitchOn] = useState(true);
  const [filterAllowed, setFilterAllowed] = useState(true);
  const [directoryFiltersOpen, setDirectoryFiltersOpen] = useState(false);
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  return <div className="ds-gallery">
    <aside className="ds-gallery-nav">
      <div><span>WA Studio</span><strong>Design System v1</strong></div>
      <nav aria-label="Design System sections">
        <a href="#foundation">Foundation</a>
        <a href="#actions">Actions</a>
        <a href="#fields">Fields</a>
        <a href="#selection">Selection</a>
        <a href="#feedback">Feedback</a>
        <a href="#navigation">Navigation</a>
        <a href="#composition">Composition</a>
      </nav>
      <p>Product-owned · WARP-inspired</p>
    </aside>

    <main className="ds-gallery-main">
      <header className="ds-gallery-hero">
        <span>Foundation preview</span>
        <h1>WA Design System</h1>
        <p>Compact, quiet, operational desktop UI. This gallery is development-only and is not part of WA Studio production navigation.</p>
      </header>

      <section className="ds-gallery-section" id="foundation">
        <StateBoundary component="SectionHeader">
          <SectionHeader description="Product-owned tokens define the visual direction before components." eyebrow="01" title="Foundation" titleId="foundation-title" />
        </StateBoundary>
        <div className="ds-foundation-grid">
          <Specimen description="Canvas, chrome, raised, control, hover, and selected roles." title="Surface stack">
            <div className="ds-swatches">
              {[
                ["Canvas", "canvas"],
                ["Chrome", "chrome"],
                ["Raised", "raised"],
                ["Control", "control"],
                ["Hover", "hover"],
                ["Selected", "selected"],
              ].map(([label, value]) => <div className={`ds-swatch ds-swatch-${value}`} key={value}><span>{label}</span></div>)}
            </div>
          </Specimen>
          <Specimen description="Each product region consumes a semantic role; raw scale tokens stay private to the foundation." title="Typography roles">
            <div className="ds-type-scale">
              {[
                ["Page title · 20", "page-title", "Operational workspace"],
                ["Overlay title · 15", "overlay-title", "North America operations"],
                ["Section title · 14", "section-title", "Runtime target assessment"],
                ["Primary data · 14", "data-primary", "Release coordinators"],
                ["Dense value · 13", "data-value", "575 synchronized groups"],
                ["Supporting copy · 12", "supporting", "Human-readable guidance stays calm and legible."],
                ["Technical metadata · 11", "technical", "30 Aug 2026 · POLICY_READY · 70cf89e8"],
                ["Compact label · 11", "compact", "Allowed"],
                ["Overline · 10", "overline", "SAVED SNAPSHOT"],
              ].map(([label, role, sample]) => (
                <div className="ds-type-role" data-role={role} key={role}>
                  <span>{label}</span>
                  <strong>{sample}</strong>
                </div>
              ))}
            </div>
          </Specimen>
          <Specimen description="Product identity, icon grammar, status reinforcement, and timestamps use shipped primitives." title="Product marks and metadata">
            <div className="ds-row ds-row-wrap">
              <StateBoundary component="BrandMark"><BrandMark size="sm" /><BrandMark /><BrandMark size="lg" /></StateBoundary>
              <StateBoundary component="AppIcon"><AppIcon name="groups" size="xs" /><AppIcon name="activity" /><AppIcon name="settings" size="lg" /></StateBoundary>
              <StateBoundary component="StatusDot"><StatusDot tone="neutral" /><StatusDot tone="info" /><StatusDot tone="success" /><StatusDot tone="warning" /><StatusDot tone="danger" /></StateBoundary>
              <StateBoundary component="DateTime"><DateTime value="2026-08-30T12:00:00.000Z" /><DateTime relativeStyle="compact" value="2026-08-30T12:00:00.000Z" variant="relative" /></StateBoundary>
            </div>
          </Specimen>
        </div>
      </section>

      <section className="ds-gallery-section" id="actions">
        <SectionHeader description="One anatomy across sizes, hierarchy, loading, and destructive actions." eyebrow="02" title="Actions" titleId="actions-title" />
        <Specimen description="Primary is scarce; secondary and ghost carry routine operations." title="Button matrix">
          <div className="ds-row ds-row-wrap">
            <StateBoundary component="Button">
              <Button size="sm">Compact</Button>
              <Button>Secondary</Button>
              <Button variant="primary">Primary action</Button>
              <Button icon="refresh">Reload</Button>
              <Button icon="settings" variant="ghost">Settings</Button>
              <Button variant="danger">Delete</Button>
              <Button disabled>Disabled</Button>
              <Button loading>Working</Button>
              <Button aria-label="Refresh" icon="refresh" />
            </StateBoundary>
            <StateBoundary component="FilterChip"><FilterChip label="Allowed" onRemove={() => undefined} /></StateBoundary>
            <StateBoundary component="DataTablePrimaryAction"><DataTablePrimaryAction>Primary table row</DataTablePrimaryAction></StateBoundary>
          </div>
        </Specimen>
      </section>

      <section className="ds-gallery-section" id="fields">
        <SectionHeader description="Text and selector controls share height, surface, border, hover, and focus states." eyebrow="03" title="Fields and selectors" titleId="fields-title" />
        <div className="ds-grid-3">
          <StateBoundary component="TextField">
            <TextField description="Normal body-family input." label="Campaign name" placeholder="e.g. August product update" />
            <TextField description="Machine-oriented values use mono." label="Runtime URL" monospace value="https://runtime.local" readOnly />
            <TextField error="A name is required." label="Invalid field" />
            <TextField disabled label="Disabled field" value="Unavailable" />
          </StateBoundary>
          <StateBoundary component="SearchField"><SearchField label="Find campaigns" onChange={() => undefined} placeholder="Search campaigns" value="" /></StateBoundary>
          <StateBoundary component="SelectMenu"><SelectMenu label="Schedule" onChange={setSchedule} options={selectOptions} value={schedule} /></StateBoundary>
          <StateBoundary component="SearchSelect"><SearchSelect label="Active session" onChange={setSession} options={sessionOptions} value={session} /></StateBoundary>
        </div>
        <div className="ds-spacer" />
        <StateBoundary component="TextAreaField"><TextAreaField description="Long Vietnamese copy must wrap without breaking the field anatomy." label="Message text" defaultValue="Nội dung dài vẫn phải rõ ràng, dễ đọc và giữ đúng nhịp điệu của giao diện desktop." /></StateBoundary>
      </section>

      <section className="ds-gallery-section" id="selection">
        <SectionHeader description="Use the selector whose geometry matches option count and consequence." eyebrow="04" title="Selection" titleId="selection-title" />
        <div className="ds-grid-2">
          <Specimen description="Native table/membership checkbox and compact filter option." title="Checkboxes and filters">
            <div className="ds-row ds-row-wrap">
              <StateBoundary component="Checkbox">
                <label className="ds-checkbox-label"><Checkbox defaultChecked /> Selected row</label>
                <label className="ds-checkbox-label"><Checkbox /> Available row</label>
                <label className="ds-checkbox-label"><Checkbox aria-checked="mixed" ref={(node) => { if (node) node.indeterminate = true; }} /> Mixed row</label>
                <label className="ds-checkbox-label"><Checkbox disabled /> Disabled row</label>
              </StateBoundary>
              <StateBoundary component="FilterOption">
                <FilterOption checked={filterAllowed} onChange={(event) => setFilterAllowed(event.currentTarget.checked)}>Allowed</FilterOption>
                <FilterOption type="radio">Current</FilterOption>
              </StateBoundary>
            </div>
          </Specimen>
          <Specimen description="Switches change durable settings; copy explains consequence." title="Switch">
            <StateBoundary component="SwitchField"><SwitchField checked={switchOn} description="Runtime enforces this policy for new live runs." label="Live-send protection" onChange={(event) => setSwitchOn(event.currentTarget.checked)} /><SwitchField checked={false} disabled description="Unavailable while Runtime is offline." label="Offline policy" readOnly /></StateBoundary>
          </Specimen>
          <Specimen description="Two compact peer options without secondary copy inside each option." title="Segmented control">
            <StateBoundary component="SegmentedControl"><SegmentedControl label="Execution mode" onChange={setMode} options={[
              { description: "Evaluate without creating delivery work.", label: "Dry run", value: "dry" },
              { description: "Apply live policy.", label: "Live policy", value: "live" },
            ]} value={mode} /></StateBoundary>
          </Specimen>
          <Specimen description="Use when each option needs consequence copy or metadata." title="Decision group">
            <StateBoundary component="DecisionGroup"><DecisionGroup label="Launch policy" onChange={setMode} options={[
              { description: "Evaluate the campaign as a simulation.", label: "Dry run", meta: <Badge tone="neutral">Safe</Badge>, value: "dry" },
              { description: "Apply live safety policy before creating work.", label: "Live policy", meta: <Badge tone="warning">Protected</Badge>, value: "live" },
            ]} value={mode} /></StateBoundary>
          </Specimen>
        </div>
      </section>

      <section className="ds-gallery-section" id="feedback">
        <SectionHeader description="Semantic color communicates state; normal success remains compact." eyebrow="05" title="Status and feedback" titleId="feedback-title" />
        <Specimen description="Status variants use a dot for normal state and alert geometry for attention." title="Badge matrix">
          <div className="ds-row ds-row-wrap">
            <StateBoundary component="Badge"><Badge>Neutral</Badge><Badge tone="info" variant="status">Checking</Badge><Badge tone="success" variant="status">Allowed</Badge><Badge tone="warning" variant="status">Stale</Badge><Badge tone="danger" variant="status">Denied</Badge></StateBoundary>
          </div>
        </Specimen>
        <StateBoundary component="InlineAlert"><div className="ds-feedback-stack">
          <InlineAlert indicator title="Capability updated" tone="success">The latest result is now visible.</InlineAlert>
          <InlineAlert indicator title="Refresh continues in background" tone="warning">Progress will resume when this view is reopened.</InlineAlert>
          <InlineAlert action={<Button size="sm">Retry</Button>} title="Could not load activity">Runtime is unavailable.</InlineAlert>
        </div></StateBoundary>
        <div className="ds-spacer" />
        <StateBoundary component="Toast"><GalleryToastDemo /></StateBoundary>
      </section>

      <section className="ds-gallery-section" id="navigation">
        <SectionHeader description="Tabs switch peers; steppers describe sequential workflow." eyebrow="06" title="Navigation and overlays" titleId="navigation-title" />
        <div className="ds-stack">
          <StateBoundary component="Tabs"><Tabs activeTab={activeTab} ariaLabel="Inspector views" idPrefix="gallery-tabs" onChange={setActiveTab} tabs={[
            { id: "overview", label: "Overview" },
            { id: "members", label: "Members", warning: true },
          ]} /></StateBoundary>
          <GalleryTabPanel active={activeTab === "overview"} idPrefix="gallery-tabs" itemId="overview">Overview specimen is active.</GalleryTabPanel>
          <GalleryTabPanel active={activeTab === "members"} idPrefix="gallery-tabs" itemId="members">Members specimen is active.</GalleryTabPanel>
          <StateBoundary component="WorkflowStepper"><WorkflowStepper activeStep={activeStep} ariaLabel="Campaign workflow" idPrefix="gallery-workflow" onChange={setActiveStep} steps={[
            { id: "content", label: "Content", step: 1 },
            { id: "targets", label: "Targets", step: 2 },
            { id: "review", label: "Review & launch", meta: "Pass", step: 3 },
          ]} /></StateBoundary>
          <GalleryTabPanel active={activeStep === "content"} idPrefix="gallery-workflow" itemId="content">Content step is active.</GalleryTabPanel>
          <GalleryTabPanel active={activeStep === "targets"} idPrefix="gallery-workflow" itemId="targets">Targets step is active.</GalleryTabPanel>
          <GalleryTabPanel active={activeStep === "review"} idPrefix="gallery-workflow" itemId="review">Review and launch step is active.</GalleryTabPanel>
          <div className="ds-row ds-row-wrap">
            <StateBoundary component="DropdownMenu"><DropdownMenu ariaLabel="Campaign actions" trigger={(props) => <Button {...props} icon="more">Actions</Button>}>
              <DropdownMenuItem icon="edit" onSelect={() => undefined}>Edit campaign</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger description="Run history will be retained." icon="trash" onSelect={() => undefined}>Delete campaign</DropdownMenuItem>
            </DropdownMenu></StateBoundary>
            <StateBoundary component="ModalDialog"><Button onClick={() => setModalOpen(true)}>Open modal</Button></StateBoundary>
            <StateBoundary component="ConfirmationDialog"><Button onClick={() => setConfirmationOpen(true)}>Open confirmation</Button></StateBoundary>
            <StateBoundary component="WorkspaceDialog"><Button onClick={() => setWorkspaceOpen(true)}>Open workspace</Button></StateBoundary>
            <StateBoundary component="Drawer">
              <StateBoundary component="InspectorDrawer"><GalleryDrawerDemo /></StateBoundary>
            </StateBoundary>
            <StateBoundary component="TablePagination"><TablePagination limit={20} offset={0} onOffsetChange={() => undefined} total={71} /></StateBoundary>
          </div>
        </div>
        <ModalDialog description="Modal focus is isolated and returns to its trigger." eyebrow="Overlay" footer={<div className="ds-row"><Button onClick={() => setModalOpen(false)}>Cancel</Button><Button variant="primary">Continue</Button></div>} onClose={() => setModalOpen(false)} open={modalOpen} title="Confirm operation">
          <InlineAlert indicator title="Review required" tone="warning">This specimen demonstrates modal hierarchy and focus ownership.</InlineAlert>
        </ModalDialog>
        <ConfirmationDialog
          body="This action uses explicit confirmation and returns focus to its trigger."
          confirmLabel="Delete draft"
          confirmVariant="danger"
          onCancel={() => setConfirmationOpen(false)}
          onConfirm={() => setConfirmationOpen(false)}
          open={confirmationOpen}
          title="Delete campaign draft?"
        />
        <WorkspaceDialog
          description="Large editing tasks retain navigation and one fixed action footer."
          footer={<div className="ds-row"><Button onClick={() => setWorkspaceOpen(false)}>Cancel</Button><Button variant="primary">Save draft</Button></div>}
          navigation={<WorkflowStepper activeStep="content" ariaLabel="Workspace steps" idPrefix="gallery-workspace" onChange={() => undefined} steps={[{ id: "content", label: "Content", step: 1 }, { id: "targets", label: "Targets", step: 2 }]} />}
          onClose={() => setWorkspaceOpen(false)}
          open={workspaceOpen}
          title="Campaign workspace"
        >
          <div
            aria-labelledby="gallery-workspace-content-tab"
            id="gallery-workspace-content-panel"
            role="tabpanel"
          >
            <PageHeader description="Edit an immutable message snapshot." title="Content & schedule" />
            <TextField label="Campaign name" value="August operations" readOnly />
          </div>
          <div
            aria-labelledby="gallery-workspace-targets-tab"
            hidden
            id="gallery-workspace-targets-panel"
            role="tabpanel"
          >
            Target selection specimen
          </div>
        </WorkspaceDialog>
      </section>

      <section className="ds-gallery-section" id="composition">
        <SectionHeader description="Reference compositions validate hierarchy before product rollout." eyebrow="07" title="Composition patterns" titleId="composition-title" />
        <div className="ds-stack ds-reference-stack">
          <StateBoundary component="PageHeader"><PageHeader actions={<Button>New campaign</Button>} description="Product pages keep one title, one concise purpose, and scarce primary actions." title="Campaign workspace" /></StateBoundary>
          <StateBoundary component="SurfacePanel"><SurfacePanel description="Capability state captured by this decision." flush headingLevel={2} title="Runtime target assessment" titleId="readiness-title">
            <StateBoundary component="MetricGrid"><MetricGrid ariaLabel="Target readiness" items={[
              { label: "Total", value: 71 },
              { label: "Allowed", tone: "success", value: 71 },
              { label: "Denied", tone: "danger", value: 0 },
              { label: "Unknown", tone: "warning", value: 0 },
            ]} /></StateBoundary>
          </SurfacePanel></StateBoundary>

          <SurfacePanel description="Checks contributing to Runtime's decision." flush title="Policy checks" titleId="policy-title">
            <StateBoundary component="EvidenceList"><EvidenceList ariaLabel="Policy checks" items={[
              { description: "Image content is valid", id: "content", meta: "CONTENT_VALID", status: <Badge tone="success" variant="status">Pass</Badge>, title: "Campaign content" },
              { description: "Dry-run does not consume the live safety budget", id: "safety", meta: "SAFETY_READY", status: <Badge tone="success" variant="status">Pass</Badge>, title: "OpenWA safety" },
              { description: "Session is ready", id: "session", meta: "SESSION_SENDABLE", status: <Badge tone="success" variant="status">Pass</Badge>, title: "Runtime session" },
            ]} /></StateBoundary>
          </SurfacePanel>

          <StateBoundary component="DataTableFrame"><DataTableFrame footer={<TablePagination limit={20} offset={0} onOffsetChange={() => undefined} total={2} />} label="Group directory" scroll={false}>
            <StateBoundary component="DataFilterToolbar"><DataFilterToolbar
              filterCount={0}
              filtersOpen={directoryFiltersOpen}
              idPrefix="gallery-directory"
              onCloseFilters={() => setDirectoryFiltersOpen(false)}
              onSearchChange={setDirectoryQuery}
              onToggleFilters={() => setDirectoryFiltersOpen((open) => !open)}
              resultSummary="2 groups"
              searchLabel="Search groups"
              searchPlaceholder="Search name, ID, or description"
              searchValue={directoryQuery}
            >
              {(closeFilters) => (
                <section aria-label="Group filters" className="data-filter-panel" id="gallery-directory-filter-panel">
                  <header className="data-filter-panel-header"><div><strong>Filter groups</strong><span>Optional criteria</span></div><Button aria-label="Close group filters" icon="close" onClick={closeFilters} variant="ghost" /></header>
                  <div className="data-filter-panel-body"><fieldset><legend>Capability</legend><div className="data-filter-options"><FilterOption checked={filterAllowed} onChange={() => setFilterAllowed((allowed) => !allowed)}>Allowed</FilterOption></div></fieldset></div>
                </section>
              )}
            </DataFilterToolbar></StateBoundary>
            <DataTableScroll>
              <StateBoundary component="DataTable"><DataTable caption="Synchronized groups">
                <thead><tr><th className="data-selection-cell" scope="col"><span className="ds-visually-hidden">Select</span></th><th scope="col">Name</th><th className="data-column-number" scope="col">Participants</th><th scope="col">Capability</th></tr></thead>
                <tbody>
                  <tr data-selected="true"><td className="data-selection-cell"><Checkbox aria-label="Select North America operations" defaultChecked /></td><td><strong className="data-primary-text">North America operations</strong><span className="data-identifier">120363149845@g.us</span></td><td className="data-cell-number">404</td><td className="data-cell-status"><Badge tone="success" variant="status">Allowed</Badge></td></tr>
                  <tr><td className="data-selection-cell"><Checkbox aria-label="Select Product research" /></td><td><strong className="data-primary-text">Product research with a deliberately long synchronized title</strong><span className="data-identifier">120363165482@g.us</span></td><td className="data-cell-number">1,001</td><td className="data-cell-status"><Badge tone="warning" variant="status">Unknown · stale</Badge></td></tr>
                </tbody>
              </DataTable></StateBoundary>
            </DataTableScroll>
          </DataTableFrame></StateBoundary>

          <div className="ds-reference-grid">
            <SurfacePanel description="Task-oriented settings use one row grammar." title="Settings form" titleId="settings-pattern-title">
              <div className="ds-settings-pattern">
                <SwitchField checked description="Protect sessions with Runtime's live-send policy." label="Live-send protection" readOnly />
                <div><span>OpenWA endpoint</span><code>https://openwa.onio.cc</code><Button size="sm">Change</Button></div>
              </div>
            </SurfacePanel>
            <SurfacePanel description="Details use tabs, summary metrics, and quiet sections." title="Inspector" titleId="inspector-pattern-title">
              <Tabs activeTab="overview" ariaLabel="Group inspector" idPrefix="gallery-inspector" onChange={() => undefined} tabs={[{ id: "overview", label: "Overview" }, { id: "members", label: "Members" }]} />
              <GalleryTabPanel active idPrefix="gallery-inspector" itemId="overview">Inspector overview is active.</GalleryTabPanel>
              <GalleryTabPanel active={false} idPrefix="gallery-inspector" itemId="members">Inspector members view.</GalleryTabPanel>
              <MetricGrid ariaLabel="Group summary" items={[{ label: "Participants", value: "1,001" }, { label: "Access", value: "Allowed" }]} />
              <StateBoundary component="DescriptionList"><DescriptionList ariaLabel="Group identifiers" items={[
                { id: "group-id", label: "Group ID", value: "120363165482@g.us", valueClassName: "ui-technical-text" },
                { id: "synced", label: "Record synced", value: "30 Aug 2026 · 19:02" },
              ]} /></StateBoundary>
            </SurfacePanel>
          </div>

          <div className="ds-workflow-pattern">
            <WorkflowStepper activeStep="review" ariaLabel="Reference workflow" idPrefix="reference-workflow" onChange={() => undefined} steps={[
              { id: "content", label: "Content", step: 1 },
              { id: "targets", label: "Targets", step: 2 },
              { id: "review", label: "Review & launch", step: 3 },
            ]} />
            <GalleryTabPanel active={false} idPrefix="reference-workflow" itemId="content">Reference content step.</GalleryTabPanel>
            <GalleryTabPanel active={false} idPrefix="reference-workflow" itemId="targets">Reference targets step.</GalleryTabPanel>
            <GalleryTabPanel active idPrefix="reference-workflow" itemId="review">Reference review and launch step is active.</GalleryTabPanel>
            <SectionHeader description="Inspect saved evidence before creating an immutable run." divider={false} eyebrow="Safety gate" headingLevel={3} title="Review & launch" titleId="reference-review-title" />
            <InlineAlert indicator title="No target issues" tone="success">Runtime found no groups that require operator attention.</InlineAlert>
            <StateBoundary component="ActionFooter"><ActionFooter actions={<><Button>Back</Button><Button variant="primary">Create dry run</Button></>} description="PASS · 71/71 eligible" title="Step 3 of 3 · Review & launch" /></StateBoundary>
          </div>

          <StateBoundary component="EmptyState"><EmptyState icon="activity" title="No activity yet">Operational events will appear after Runtime accepts work.</EmptyState></StateBoundary>
        </div>
      </section>
    </main>
  </div>;
}
