/**
 * Reports hook — WYSIWYG preview from generated document blobs
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
import { getSampleCount } from "../services/metricsHistoryService";

const DEFAULT_CONFIG = {
  intervalKey: "1h",
  customRange: null,
  title: "",
  generatedBy: "",
  description: "",
};

const ALL_FORMATS = SUPPORTED_FORMATS.filter((f) => f.supported).map((f) => f.id);
const AUTO_REGEN_MS = 1200;

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

  const lastGeneratedSig = useRef(null);
  const autoGenTimer = useRef(null);
  const generateRef = useRef(null);

  useEffect(() => subscribeReportHistory(setHistory), []);

  const previewReportData = useMemo(() => {
    try {
      return buildReportData({ ...config, sections: sectionSelection });
    } catch {
      return null;
    }
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
    if (availableSections.length === 0) return;

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
      lastGeneratedSig.current = currentSig;
      setIsStale(false);
      if (result.pageCount) setTotalPages(result.pageCount);
    } catch (err) {
      console.error("Report generation failed", err);
      setError(err?.message || "Failed to generate report");
    } finally {
      setGenerating(false);
    }
  }, [config, sectionSelection, availableSections.length, currentSig]);

  generateRef.current = handleGenerate;

  useEffect(() => {
    markStale();
  }, [currentSig, markStale]);

  useEffect(() => {
    if (availableSections.length === 0) return undefined;
    if (!lastGeneratedSig.current) return undefined;

    if (autoGenTimer.current) clearTimeout(autoGenTimer.current);

    autoGenTimer.current = setTimeout(() => {
      if (lastGeneratedSig.current === currentSig) return;
      generateRef.current?.();
    }, AUTO_REGEN_MS);

    return () => {
      if (autoGenTimer.current) clearTimeout(autoGenTimer.current);
    };
  }, [currentSig, availableSections.length]);

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
    sampleCount: getSampleCount(),
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
