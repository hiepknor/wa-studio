import { useState } from "react";

import { Badge } from "../shared/ui/Badge";
import { Button } from "../shared/ui/Button";
import { Checkbox } from "../shared/ui/Checkbox";
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
import { DecisionGroup } from "../shared/ui/DecisionGroup";
import { DataTablePrimaryAction } from "../shared/ui/DataTablePrimaryAction";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../shared/ui/DropdownMenu";
import { FilterOption } from "../shared/ui/FilterOption";
import { FilterChip } from "../shared/ui/FilterChip";
import { InlineAlert } from "../shared/ui/InlineAlert";
import { ModalDialog } from "../shared/ui/ModalDialog";
import { SearchSelect } from "../shared/ui/SearchSelect";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { SelectMenu } from "../shared/ui/SelectMenu";
import { SwitchField } from "../shared/ui/SwitchField";
import { TablePagination } from "../shared/ui/TablePagination";
import { Tabs } from "../shared/ui/Tabs";
import { TextAreaField } from "../shared/ui/TextAreaField";
import { TextField } from "../shared/ui/TextField";
import { useToast } from "../shared/ui/Toast";
import { WorkflowStepper } from "../shared/ui/WorkflowStepper";

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
  const [modalOpen, setModalOpen] = useState(false);

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
        <SectionHeader description="Product-owned tokens define the visual direction before components." eyebrow="01" title="Foundation" titleId="foundation-title" />
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
          <Specimen description="Body copy stays human; technical evidence uses mono." title="Typography roles">
            <div className="ds-type-scale">
              <h2>Operational workspace title</h2>
              <p>Human-readable supporting copy stays calm and legible.</p>
              <strong>Medium emphasis for actions and key values</strong>
              <code>30 Aug 2026 · POLICY_READY · 70cf89e8</code>
              <small>UPPERCASE MICRO LABEL</small>
            </div>
          </Specimen>
        </div>
      </section>

      <section className="ds-gallery-section" id="actions">
        <SectionHeader description="One anatomy across sizes, hierarchy, loading, and destructive actions." eyebrow="02" title="Actions" titleId="actions-title" />
        <Specimen description="Primary is scarce; secondary and ghost carry routine operations." title="Button matrix">
          <div className="ds-row ds-row-wrap">
            <Button size="sm">Compact</Button>
            <Button>Secondary</Button>
            <Button variant="primary">Primary action</Button>
            <Button icon="refresh">Reload</Button>
            <Button icon="settings" variant="ghost">Settings</Button>
            <Button variant="danger">Delete</Button>
            <Button disabled>Disabled</Button>
            <Button loading>Working</Button>
            <Button aria-label="Refresh" icon="refresh" />
            <FilterChip label="Allowed" onRemove={() => undefined} />
            <DataTablePrimaryAction>Primary table row</DataTablePrimaryAction>
          </div>
        </Specimen>
      </section>

      <section className="ds-gallery-section" id="fields">
        <SectionHeader description="Text and selector controls share height, surface, border, hover, and focus states." eyebrow="03" title="Fields and selectors" titleId="fields-title" />
        <div className="ds-grid-3">
          <TextField description="Normal body-family input." label="Campaign name" placeholder="e.g. August product update" />
          <TextField description="Machine-oriented values use mono." label="Runtime URL" monospace value="https://runtime.local" readOnly />
          <TextField error="A name is required." label="Invalid field" />
          <SelectMenu label="Schedule" onChange={setSchedule} options={selectOptions} value={schedule} />
          <SearchSelect label="Active session" onChange={setSession} options={sessionOptions} value={session} />
          <TextField disabled label="Disabled field" value="Unavailable" />
        </div>
        <div className="ds-spacer" />
        <TextAreaField description="Long Vietnamese copy must wrap without breaking the field anatomy." label="Message text" defaultValue="Nội dung dài vẫn phải rõ ràng, dễ đọc và giữ đúng nhịp điệu của giao diện desktop." />
      </section>

      <section className="ds-gallery-section" id="selection">
        <SectionHeader description="Use the selector whose geometry matches option count and consequence." eyebrow="04" title="Selection" titleId="selection-title" />
        <div className="ds-grid-2">
          <Specimen description="Native table/membership checkbox and compact filter option." title="Checkboxes and filters">
            <div className="ds-row ds-row-wrap">
              <label className="ds-checkbox-label"><Checkbox defaultChecked /> Selected row</label>
              <label className="ds-checkbox-label"><Checkbox /> Available row</label>
              <label className="ds-checkbox-label"><Checkbox disabled /> Disabled row</label>
              <FilterOption checked={filterAllowed} onChange={(event) => setFilterAllowed(event.currentTarget.checked)}>Allowed</FilterOption>
              <FilterOption type="radio">Current</FilterOption>
            </div>
          </Specimen>
          <Specimen description="Switches change durable settings; copy explains consequence." title="Switch">
            <SwitchField checked={switchOn} description="Runtime enforces this policy for new live runs." label="Live-send protection" onChange={(event) => setSwitchOn(event.currentTarget.checked)} />
          </Specimen>
          <Specimen description="Two compact peer options without secondary copy inside each option." title="Segmented control">
            <SegmentedControl label="Execution mode" onChange={setMode} options={[
              { description: "Evaluate without creating delivery work.", label: "Dry run", value: "dry" },
              { description: "Apply live policy.", label: "Live policy", value: "live" },
            ]} value={mode} />
          </Specimen>
          <Specimen description="Use when each option needs consequence copy or metadata." title="Decision group">
            <DecisionGroup label="Launch policy" onChange={setMode} options={[
              { description: "Evaluate the campaign as a simulation.", label: "Dry run", meta: <Badge tone="neutral">Safe</Badge>, value: "dry" },
              { description: "Apply live safety policy before creating work.", label: "Live policy", meta: <Badge tone="warning">Protected</Badge>, value: "live" },
            ]} value={mode} />
          </Specimen>
        </div>
      </section>

      <section className="ds-gallery-section" id="feedback">
        <SectionHeader description="Semantic color communicates state; normal success remains compact." eyebrow="05" title="Status and feedback" titleId="feedback-title" />
        <Specimen description="Status variants use a dot for normal state and alert geometry for attention." title="Badge matrix">
          <div className="ds-row ds-row-wrap">
            <Badge>Neutral</Badge>
            <Badge tone="info" variant="status">Checking</Badge>
            <Badge tone="success" variant="status">Allowed</Badge>
            <Badge tone="warning" variant="status">Stale</Badge>
            <Badge tone="danger" variant="status">Denied</Badge>
          </div>
        </Specimen>
        <div className="ds-feedback-stack">
          <InlineAlert indicator title="Capability updated" tone="success">The latest result is now visible.</InlineAlert>
          <InlineAlert indicator title="Refresh continues in background" tone="warning">Progress will resume when this view is reopened.</InlineAlert>
          <InlineAlert action={<Button size="sm">Retry</Button>} title="Could not load activity">Runtime is unavailable.</InlineAlert>
        </div>
        <div className="ds-spacer" />
        <GalleryToastDemo />
      </section>

      <section className="ds-gallery-section" id="navigation">
        <SectionHeader description="Tabs switch peers; steppers describe sequential workflow." eyebrow="06" title="Navigation and overlays" titleId="navigation-title" />
        <div className="ds-stack">
          <Tabs activeTab={activeTab} ariaLabel="Inspector views" idPrefix="gallery-tabs" onChange={setActiveTab} tabs={[
            { id: "overview", label: "Overview" },
            { id: "members", label: "Members", warning: true },
          ]} />
          <GalleryTabPanel active={activeTab === "overview"} idPrefix="gallery-tabs" itemId="overview">Overview specimen is active.</GalleryTabPanel>
          <GalleryTabPanel active={activeTab === "members"} idPrefix="gallery-tabs" itemId="members">Members specimen is active.</GalleryTabPanel>
          <WorkflowStepper activeStep={activeStep} ariaLabel="Campaign workflow" idPrefix="gallery-workflow" onChange={setActiveStep} steps={[
            { id: "content", label: "Content", step: 1 },
            { id: "targets", label: "Targets", step: 2 },
            { id: "review", label: "Review & launch", meta: "Pass", step: 3 },
          ]} />
          <GalleryTabPanel active={activeStep === "content"} idPrefix="gallery-workflow" itemId="content">Content step is active.</GalleryTabPanel>
          <GalleryTabPanel active={activeStep === "targets"} idPrefix="gallery-workflow" itemId="targets">Targets step is active.</GalleryTabPanel>
          <GalleryTabPanel active={activeStep === "review"} idPrefix="gallery-workflow" itemId="review">Review and launch step is active.</GalleryTabPanel>
          <div className="ds-row ds-row-wrap">
            <DropdownMenu ariaLabel="Campaign actions" trigger={(props) => <Button {...props} icon="more">Actions</Button>}>
              <DropdownMenuItem icon="edit" onSelect={() => undefined}>Edit campaign</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger description="Run history will be retained." icon="trash" onSelect={() => undefined}>Delete campaign</DropdownMenuItem>
            </DropdownMenu>
            <Button onClick={() => setModalOpen(true)}>Open modal</Button>
            <TablePagination limit={20} offset={0} onOffsetChange={() => undefined} total={71} />
          </div>
        </div>
        <ModalDialog description="Modal focus is isolated and returns to its trigger." eyebrow="Overlay" footer={<div className="ds-row"><Button onClick={() => setModalOpen(false)}>Cancel</Button><Button variant="primary">Continue</Button></div>} onClose={() => setModalOpen(false)} open={modalOpen} title="Confirm operation">
          <InlineAlert indicator title="Review required" tone="warning">This specimen demonstrates modal hierarchy and focus ownership.</InlineAlert>
        </ModalDialog>
      </section>

      <section className="ds-gallery-section" id="composition">
        <SectionHeader description="Reference compositions validate hierarchy before product rollout." eyebrow="07" title="Composition patterns" titleId="composition-title" />
        <div className="ds-stack ds-reference-stack">
          <SurfacePanel description="Capability state captured by this decision." flush title="Runtime target assessment" titleId="readiness-title">
            <MetricGrid ariaLabel="Target readiness" items={[
              { label: "Total", value: 71 },
              { label: "Allowed", tone: "success", value: 71 },
              { label: "Denied", tone: "danger", value: 0 },
              { label: "Unknown", tone: "warning", value: 0 },
            ]} />
          </SurfacePanel>

          <SurfacePanel description="Checks contributing to Runtime's decision." flush title="Policy checks" titleId="policy-title">
            <EvidenceList ariaLabel="Policy checks" items={[
              { description: "Image content is valid", id: "content", meta: "CONTENT_VALID", status: <Badge tone="success" variant="status">Pass</Badge>, title: "Campaign content" },
              { description: "Dry-run does not consume the live safety budget", id: "safety", meta: "SAFETY_READY", status: <Badge tone="success" variant="status">Pass</Badge>, title: "OpenWA safety" },
              { description: "Session is ready", id: "session", meta: "SESSION_SENDABLE", status: <Badge tone="success" variant="status">Pass</Badge>, title: "Runtime session" },
            ]} />
          </SurfacePanel>

          <DataTableFrame footer={<TablePagination limit={20} offset={0} onOffsetChange={() => undefined} total={2} />} label="Group directory" toolbar={<div className="ds-table-toolbar"><TextField label="Search groups" labelHidden placeholder="Search name, ID, or description" /><Button icon="settings">Filters</Button><span>2 groups</span></div>}>
            <table className="ds-reference-table">
              <thead><tr><th><span className="ds-visually-hidden">Select</span></th><th>Name</th><th>Participants</th><th>Capability</th></tr></thead>
              <tbody>
                <tr><td><Checkbox aria-label="Select North America operations" /></td><td><strong>North America operations</strong><code>120363149845@g.us</code></td><td>404</td><td><Badge tone="success" variant="status">Allowed</Badge></td></tr>
                <tr><td><Checkbox aria-label="Select Product research" /></td><td><strong>Product research with a deliberately long synchronized title</strong><code>120363165482@g.us</code></td><td>1,001</td><td><Badge tone="warning" variant="status">Unknown · stale</Badge></td></tr>
              </tbody>
            </table>
          </DataTableFrame>

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
              <DescriptionList ariaLabel="Group identifiers" items={[
                { id: "group-id", label: "Group ID", value: "120363165482@g.us", valueClassName: "data-identifier" },
                { id: "synced", label: "Record synced", value: "30 Aug 2026 · 19:02" },
              ]} />
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
            <ActionFooter actions={<><Button>Back</Button><Button variant="primary">Create dry run</Button></>} description="PASS · 71/71 eligible" title="Step 3 of 3 · Review & launch" />
          </div>

          <EmptyState icon="activity" title="No activity yet">Operational events will appear after Runtime accepts work.</EmptyState>
        </div>
      </section>
    </main>
  </div>;
}
