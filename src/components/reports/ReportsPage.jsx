/**
 * Report Center — WYSIWYG document viewer layout
 */

import { HardwareIcon } from "../ui/HardwareIcon";
import { StatusBadge } from "../ui/HardwareModule";
import { useReports } from "../../hooks/useReports";
import { ReportConfiguration } from "./ReportConfiguration";
import { ReportSectionPicker } from "./ReportSectionPicker";
import { DocumentPreviewViewer } from "./DocumentPreviewViewer";
import { GenerationProgress } from "./GenerationProgress";
import { ReportHistoryPanel } from "./ReportHistoryPanel";

export function ReportsPage({ connected, loading }) {
  const reports = useReports();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="mb-4 flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
            style={{
              background: "rgba(34, 211, 238, 0.08)",
              border: "1px solid rgba(34, 211, 238, 0.15)",
            }}
          >
            <HardwareIcon name="report" size={20} />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold tracking-tight text-[#f1f5f9]">
              Report Center
            </h1>
            <p className="text-xs text-[#64748b]">
              True document preview — identical to exported files
            </p>
          </div>
        </div>
        <StatusBadge
          status={connected ? "healthy" : "critical"}
          label={connected ? "Telemetry Active" : "Telemetry Offline"}
        />
      </header>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[340px_1fr] xl:grid-cols-[380px_1fr]">
        {/* Left — Configuration */}
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
          <ReportConfiguration
            config={reports.config}
            updateConfig={reports.updateConfig}
            sampleCount={reports.sampleCount}
            connected={connected}
            compact
          />
          <ReportSectionPicker
            availableSections={reports.availableSections}
            sectionSelection={reports.sectionSelection}
            toggleSection={reports.toggleSection}
            compact
          />

          {reports.generating && (
            <GenerationProgress progressSteps={reports.progressSteps} visible />
          )}

          <ReportHistoryPanel
            history={reports.history}
            downloadHistory={reports.downloadHistory}
            removeHistory={reports.removeHistory}
            formatFileSize={reports.formatFileSize}
            metadataEntry={reports.metadataEntry}
            setMetadataEntry={reports.setMetadataEntry}
            compact
          />
        </aside>

        {/* Right — Document viewer */}
        <div className="min-h-[480px] min-w-0 lg:min-h-0">
          <DocumentPreviewViewer
            outputs={reports.outputs}
            previewFormat={reports.previewFormat}
            onPreviewFormatChange={reports.setPreviewFormat}
            supportedFormats={reports.supportedFormats}
            zoom={reports.zoom}
            fitMode={reports.fitMode}
            onZoomChange={reports.setZoom}
            onFitModeChange={reports.setFitMode}
            currentPage={reports.currentPage}
            totalPages={reports.totalPages}
            onPageChange={reports.setCurrentPage}
            onDocumentLoad={reports.handleDocumentLoad}
            generating={reports.generating}
            onGenerate={reports.handleGenerate}
            onDownload={reports.downloadResult}
            canGenerate={!loading && reports.availableSections.length > 0}
            isStale={reports.isStale}
            error={reports.error}
          />
        </div>
      </div>
    </div>
  );
}
