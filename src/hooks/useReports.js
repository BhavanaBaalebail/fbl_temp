/**
 * Reports hook — SQLite historical reports via /reports/data
 */

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { buildReportData } from "../services/reports/reportDataBuilder";
import {
  generateReport,
  downloadFormatOutput,
  downloadFromHistoryEntry,
  SUPPORTED_FORMATS,
  GENERATION_STEPS,
} from "../services/reports/reportGenerator";
import {
  DEFAULT_SECTION_SELECTION,
  getAvailableSections,
} from "../services/reports/reportSections";
import {
  getReportHistory,
  subscribeReportHistory,
  deleteReportHistoryEntry,
  formatFileSize,
} from "../services/reports/reportHistoryManager";

const DEFAULT_CONFIG = {
  intervalKey: "1h",
  customRange: null,
  title: "",
  generatedBy: "",
  description: "",
};

const ALL_FORMATS = SUPPORTED_FORMATS.filter((f) => f.supported).map((f) => f.id);
const AUTO_REGEN_MS = 1200;
const PREVIEW_FETCH_MS = 600;

function configSignature(config, sectionSelection) {
  return JSON.stringify({ config, sectionSelection });
}

export function useReports() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [sectionSelection, setSectionSelection] = useState(DEFAULT_SECTION_SELECTION);
  const [previewFormat, setPreviewFormat] = useState("pdf");
  const [generating, setGenerating] = useState(false);
  const [progressSteps, setProgressSteps] = useState([]);
  const [generationResult, setGenerationResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState(getReportHistory);
  const [metadataEntry, setMetadataEntry] = useState(null);
  const [isStale, setIsStale] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [fitMode, setFitMode] = useState("width");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [previewReportData, setPreviewReportData] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [historySampleCount, setHistorySampleCount] = useState(0);

  const lastGeneratedSig = useRef(null);
  const autoGenTimer = useRef(null);
  const previewTimer = useRef(null);
  const generateRef = useRef(null);
  const previewSeq = useRef(0);

  useEffect(() => subscribeReportHistory(setHistory), []);

  // Preview data from SQLite (debounced) — never sessionStorage
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      const seq = ++previewSeq.current;
      setPreviewLoading(true);
      try {
        const data = await buildReportData({ ...config, sections: sectionSelection });
        if (seq !== previewSeq.current) return;
        setPreviewReportData(data);
        setHistorySampleCount(data.sampleCount || data.telemetryRawCount || 0);
        setError(null);
      } catch (err) {
        if (seq !== previewSeq.current) return;
        setPreviewReportData(null);
        setHistorySampleCount(0);
        setError(err?.message || "Failed to load historical telemetry");
      } finally {
        if (seq === previewSeq.current) setPreviewLoading(false);
      }
    }, PREVIEW_FETCH_MS);

    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [config, sectionSelection]);

  const availableSections = useMemo(
    () => (previewReportData ? getAvailableSections(previewReportData) : []),
    [previewReportData]
  );

  const currentSig = useMemo(
    () => configSignature(config, sectionSelection),
    [config, sectionSelection]
  );

  const markStale = useCallback(() => {
    if (lastGeneratedSig.current && lastGeneratedSig.current !== currentSig) {
      setIsStale(true);
    }
  }, [currentSig]);

  const updateConfig = useCallback((patch) => {
    setConfig((prev) => ({ ...prev, ...patch }));
    setError(null);
    markStale();
  }, [markStale]);

  const toggleSection = useCallback((id) => {
    setSectionSelection((prev) => ({ ...prev, [id]: !prev[id] }));
    setError(null);
    markStale();
  }, [markStale]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    setProgressSteps(GENERATION_STEPS.map((s) => ({ ...s, status: "pending" })));
    setCurrentPage(1);

    const onProgress = (index, status) => {
      setProgressSteps((prev) =>
        prev.map((step, i) => (i === index ? { ...step, status } : step))
      );
    };

    try {
      const result = await generateReport(
        { ...config, sections: sectionSelection },
        ALL_FORMATS,
        onProgress
      );
      setGenerationResult(result);
      setPreviewReportData(result.reportData);
      setHistorySampleCount(result.reportData?.sampleCount || 0);
      lastGeneratedSig.current = currentSig;
      setIsStale(false);
      if (result.pageCount) setTotalPages(result.pageCount);
    } catch (err) {
      console.error("Report generation failed", err);
      setError(err?.message || "Failed to generate report");
    } finally {
      setGenerating(false);
    }
  }, [config, sectionSelection, currentSig]);

  generateRef.current = handleGenerate;

  useEffect(() => {
    markStale();
  }, [currentSig, markStale]);

  useEffect(() => {
    if (!lastGeneratedSig.current) return undefined;

    if (autoGenTimer.current) clearTimeout(autoGenTimer.current);

    autoGenTimer.current = setTimeout(() => {
      if (lastGeneratedSig.current === currentSig) return;
      generateRef.current?.();
    }, AUTO_REGEN_MS);

    return () => {
      if (autoGenTimer.current) clearTimeout(autoGenTimer.current);
    };
  }, [currentSig]);

  const handlePreviewFormatChange = useCallback((format) => {
    setPreviewFormat(format);
    setCurrentPage(1);
    if (format === "pdf") setFitMode("width");
  }, []);

  const handleFitModeChange = useCallback((mode) => {
    setFitMode(mode);
    if (mode !== "custom") setZoom(100);
  }, []);

  const handleDocumentLoad = useCallback((info) => {
    if (info?.pageCount) setTotalPages(info.pageCount);
  }, []);

  const downloadResult = useCallback(
    (format) => {
      const fmt = format || previewFormat;
      if (generationResult?.outputs) {
        downloadFormatOutput(generationResult.outputs, fmt);
      }
    },
    [generationResult, previewFormat]
  );

  const downloadHistory = useCallback((entry, format) => {
    downloadFromHistoryEntry(entry, format);
  }, []);

  const removeHistory = useCallback((id) => {
    deleteReportHistoryEntry(id);
  }, []);

  return {
    config,
    updateConfig,
    sectionSelection,
    toggleSection,
    availableSections,
    previewFormat,
    setPreviewFormat: handlePreviewFormatChange,
    supportedFormats: SUPPORTED_FORMATS.filter((f) => f.supported),
    generating,
    progressSteps,
    generationResult,
    outputs: generationResult?.outputs ?? null,
    error,
    handleGenerate,
    downloadResult,
    history,
    downloadHistory,
    removeHistory,
    metadataEntry,
    setMetadataEntry,
    sampleCount: historySampleCount,
    previewLoading,
    previewReportData,
    formatFileSize,
    isStale,
    zoom,
    setZoom,
    fitMode,
    setFitMode: handleFitModeChange,
    currentPage,
    setCurrentPage,
    totalPages,
    handleDocumentLoad,
  };
}
