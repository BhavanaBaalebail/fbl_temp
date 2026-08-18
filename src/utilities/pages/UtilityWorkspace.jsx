/**
 * Individual FBL utility panels — adaptive layouts, value-driven rendering.
 * UI/layout only — no API or data-behavior changes.
 */

import { useCallback, useEffect, useState } from "react";
import { utilitiesApi } from "../api";
import {
  CompactMetricCard,
  DataTable,
  Field,
  KvGrid,
  PrimaryButton,
  ResultsPlaceholder,
  SelectInput,
  TextInput,
  UtilityGrid,
  UtilityPanel,
  UtilitySection,
  UtilitySplitPane,
  UtilityStatusCard,
  UtilityUnavailable,
} from "../components/Shared";
import { hasValue } from "../utils/value";
import { generateReport, downloadFormatOutput } from "../../services/reports/reportGenerator";
import { DEFAULT_SECTION_SELECTION } from "../../services/reports/reportSections";
import { fetchEmailStatus } from "../../services/emailAlertClient";
import {
  IncidentAnalysisArchitecture,
  IncidentAnalysisPanel,
} from "../../components/faults/IncidentAnalysisPanel";

function Loading() {
  return <p className="text-sm text-[#64748b]">Loading…</p>;
}

function useLoad(fetcher) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetcher();
      setState({ loading: false, data: res.data, error: res.data?.error || null });
    } catch (err) {
      setState({
        loading: false,
        data: { available: false, message: "Data unavailable on this host" },
        error: String(err?.message || err),
      });
    }
  }, [fetcher]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const res = await fetcher();
        if (!cancelled) {
          setState({ loading: false, data: res.data, error: res.data?.error || null });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            loading: false,
            data: { available: false, message: "Data unavailable on this host" },
            error: String(err?.message || err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetcher]);

  return { ...state, reload };
}

/* ─── System ─── */

function ServerUptimePanel() {
  const fetcher = useCallback(() => utilitiesApi.uptime(), []);
  const { loading, data } = useLoad(fetcher);
  if (loading) return <Loading />;
  if (!data?.available) {
    return <UtilityUnavailable message={data?.message || "Data unavailable on this host"} />;
  }
  return (
    <UtilityPanel title="Server Uptime" subtitle="Host availability since last boot" layout="compact">
      <div className="flex flex-wrap gap-2">
        <CompactMetricCard label="Uptime" value={data.uptime} emphasize />
        <CompactMetricCard label="Boot Time" value={data.boot_time} />
      </div>
    </UtilityPanel>
  );
}

function DiskUsagePanel() {
  const fetcher = useCallback(() => utilitiesApi.disk(), []);
  const { loading, data } = useLoad(fetcher);
  if (loading) return <Loading />;
  if (!data?.available || !data.mounts?.length) {
    return <UtilityUnavailable message={data?.message || "Data unavailable on this host"} />;
  }
  return (
    <UtilityPanel title="Disk Usage" subtitle="Relevant filesystems only" layout="dashboard">
      <DataTable
        columns={[
          { key: "mount", label: "Mount" },
          { key: "source", label: "Device" },
          { key: "total_gb", label: "Total GB" },
          { key: "used_gb", label: "Used GB" },
          { key: "available_gb", label: "Available GB" },
          { key: "usage_percent", label: "Usage %" },
          { key: "status", label: "Status" },
        ]}
        rows={data.mounts}
      />
    </UtilityPanel>
  );
}

function FindLargeFilesPanel() {
  const [path, setPath] = useState("/home");
  const [minMb, setMinMb] = useState(100);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);

  const scan = async () => {
    setLoading(true);
    const res = await utilitiesApi.largeFiles({ path, min_mb: Number(minMb), limit: 50 });
    setData(res.data);
    setLoading(false);
  };

  return (
    <UtilityPanel
      title="Find Large Files"
      subtitle="On-demand scan — read-only, approved paths only"
      layout="split"
    >
      <UtilitySplitPane
        left={
          <div className="space-y-3">
            <Field label="Path">
              <SelectInput value={path} onChange={(e) => setPath(e.target.value)}>
                <option value="/home">/home</option>
                <option value="/var/log">/var/log</option>
                <option value="/var/tmp">/var/tmp</option>
                <option value="/tmp">/tmp</option>
                <option value="/opt">/opt</option>
                <option value="/srv">/srv</option>
                <option value="/usr/local">/usr/local</option>
              </SelectInput>
            </Field>
            <Field label="Minimum size (MB)">
              <TextInput
                type="number"
                min={1}
                max={10240}
                value={minMb}
                onChange={(e) => setMinMb(e.target.value)}
              />
            </Field>
            <PrimaryButton onClick={scan} disabled={loading} className="w-full">
              {loading ? "Scanning…" : "Scan"}
            </PrimaryButton>
          </div>
        }
        right={
          <>
            {!data && <ResultsPlaceholder text="Choose a path and scan to list large files" />}
            {data && !data.available && (
              <UtilityUnavailable message={data.error || data.message || "Data unavailable on this host"} />
            )}
            {data?.available && !data.files?.length && (
              <UtilityUnavailable message="No files matched the scan criteria" />
            )}
            {data?.files?.length > 0 && (
              <DataTable
                columns={[
                  { key: "path", label: "Path" },
                  { key: "size_mb", label: "Size MB" },
                  { key: "mtime", label: "Modified" },
                ]}
                rows={data.files}
                dense
              />
            )}
          </>
        }
      />
    </UtilityPanel>
  );
}

function TemperatureFanPanel() {
  const fetcher = useCallback(() => utilitiesApi.temperature(), []);
  const { loading, data } = useLoad(fetcher);
  if (loading) return <Loading />;
  if (!data?.available) {
    return <UtilityUnavailable message={data?.message || "Data unavailable on this host"} />;
  }
  return (
    <UtilityPanel title="Temperature & Fan" subtitle="Live hardware sensors only" layout="dashboard">
      {data.temperatures?.length > 0 && (
        <UtilitySection title="Temperature">
          <UtilityGrid columns={3}>
            {data.temperatures.map((t, i) => (
              <CompactMetricCard
                key={`${t.label}-${i}`}
                label={t.label}
                value={`${t.celsius}°C`}
                status={t.status}
                emphasize
              />
            ))}
          </UtilityGrid>
        </UtilitySection>
      )}
      {data.fans?.length > 0 && (
        <UtilitySection title="Fans" className="mt-2">
          <DataTable
            columns={[
              { key: "label", label: "Fan" },
              { key: "rpm", label: "RPM" },
              { key: "percent", label: "%" },
            ]}
            rows={data.fans}
          />
        </UtilitySection>
      )}
      {!data.temperatures?.length && !data.fans?.length && <UtilityUnavailable />}
    </UtilityPanel>
  );
}

function RebootHistoryPanel() {
  const fetcher = useCallback(() => utilitiesApi.reboots(), []);
  const { loading, data } = useLoad(fetcher);
  if (loading) return <Loading />;
  if (!data?.available || !data.events?.length) {
    return <UtilityUnavailable message={data?.message || "Data unavailable on this host"} />;
  }
  return (
    <UtilityPanel
      title="Reboot History"
      subtitle="Recorded boot events only — reasons not invented"
      layout="compact"
    >
      <div className="max-w-2xl">
        <DataTable
          columns={[
            { key: "boot_time", label: "Boot Time" },
            { key: "status", label: "Status" },
          ]}
          rows={data.events}
          dense
        />
      </div>
    </UtilityPanel>
  );
}

/* ─── Network ─── */

function PingNodePanel() {
  const [host, setHost] = useState("127.0.0.1");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);

  const run = async () => {
    setLoading(true);
    const res = await utilitiesApi.ping({ host, count: 4 });
    setData(res.data);
    setLoading(false);
  };

  return (
    <UtilityPanel
      title="Ping Node"
      subtitle="Controlled ICMP reachability test"
      status={data?.status}
      layout="split"
    >
      <UtilitySplitPane
        left={
          <div className="space-y-3">
            <Field label="Hostname / IP">
              <TextInput
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="hostname or IP"
              />
            </Field>
            <PrimaryButton onClick={run} disabled={loading || !host.trim()} className="w-full">
              {loading ? "Pinging…" : "Ping"}
            </PrimaryButton>
          </div>
        }
        right={
          <>
            {!data && <ResultsPlaceholder text="Enter a target and run ping" />}
            {data && !data.available && (
              <UtilityUnavailable message={data.error || data.message || "Data unavailable on this host"} />
            )}
            {data?.available && (
              <KvGrid
                emphasizeFirst
                pairs={[
                  [
                    "Reachable",
                    data.reachable === true ? "Yes" : data.reachable === false ? "No" : null,
                  ],
                  ["Packets transmitted", data.packets_transmitted],
                  ["Packets received", data.packets_received],
                  [
                    "Packet loss",
                    hasValue(data.packet_loss_percent) ? `${data.packet_loss_percent}%` : null,
                  ],
                  ["Min latency", data.latency?.min_ms != null ? `${data.latency.min_ms} ms` : null],
                  ["Avg latency", data.latency?.avg_ms != null ? `${data.latency.avg_ms} ms` : null],
                  ["Max latency", data.latency?.max_ms != null ? `${data.latency.max_ms} ms` : null],
                ]}
              />
            )}
          </>
        }
      />
    </UtilityPanel>
  );
}

function PacketLossPanel() {
  const [host, setHost] = useState("127.0.0.1");
  const [count, setCount] = useState(20);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);

  const run = async () => {
    setLoading(true);
    const res = await utilitiesApi.packetLoss({ host, count: Number(count) });
    setData(res.data);
    setLoading(false);
  };

  return (
    <UtilityPanel
      title="Packet Loss"
      subtitle="Extended ping sample for loss measurement"
      status={data?.status}
      layout="split"
    >
      <UtilitySplitPane
        left={
          <div className="space-y-3">
            <Field label="Hostname / IP">
              <TextInput value={host} onChange={(e) => setHost(e.target.value)} />
            </Field>
            <Field label="Packet count">
              <TextInput
                type="number"
                min={5}
                max={100}
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </Field>
            <PrimaryButton onClick={run} disabled={loading || !host.trim()} className="w-full">
              {loading ? "Testing…" : "Start test"}
            </PrimaryButton>
          </div>
        }
        right={
          <>
            {!data && <ResultsPlaceholder text="Configure target and start the test" />}
            {data && !data.available && (
              <UtilityUnavailable message={data.error || data.message || "Data unavailable on this host"} />
            )}
            {data?.available && (
              <KvGrid
                emphasizeFirst
                pairs={[
                  [
                    "Packet loss",
                    hasValue(data.packet_loss_percent) ? `${data.packet_loss_percent}%` : null,
                  ],
                  ["Sent", data.packets_transmitted],
                  ["Received", data.packets_received],
                  [
                    "Average latency",
                    data.latency?.avg_ms != null ? `${data.latency.avg_ms} ms` : null,
                  ],
                  ["Status", data.status],
                ]}
              />
            )}
          </>
        }
      />
    </UtilityPanel>
  );
}

function PortScannerPanel() {
  const [host, setHost] = useState("127.0.0.1");
  const [ports, setPorts] = useState("22,80,443");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);

  const run = async () => {
    setLoading(true);
    const res = await utilitiesApi.ports({ host, ports });
    setData(res.data);
    setLoading(false);
  };

  return (
    <UtilityPanel
      title="Port Scanner"
      subtitle="Authorized/internal use — max 32 TCP ports"
      layout="split"
    >
      <UtilitySplitPane
        left={
          <div className="space-y-3">
            <Field label="Target host">
              <TextInput value={host} onChange={(e) => setHost(e.target.value)} />
            </Field>
            <Field label="Ports (comma or range)">
              <TextInput
                value={ports}
                onChange={(e) => setPorts(e.target.value)}
                placeholder="22,80,443 or 8000-8010"
              />
            </Field>
            <PrimaryButton onClick={run} disabled={loading} className="w-full">
              {loading ? "Scanning…" : "Scan"}
            </PrimaryButton>
          </div>
        }
        right={
          <>
            {!data && <ResultsPlaceholder text="Set target and ports, then scan" />}
            {data && !data.available && (
              <UtilityUnavailable message={data.error || data.message || "Data unavailable on this host"} />
            )}
            {data?.results?.length > 0 && (
              <DataTable
                columns={[
                  { key: "port", label: "Port" },
                  { key: "protocol", label: "Protocol" },
                  { key: "state", label: "State" },
                  { key: "service", label: "Service" },
                ]}
                rows={data.results}
              />
            )}
          </>
        }
      />
    </UtilityPanel>
  );
}

function TraceroutePanel() {
  const [host, setHost] = useState("127.0.0.1");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);

  const run = async () => {
    setLoading(true);
    const res = await utilitiesApi.traceroute({ host });
    setData(res.data);
    setLoading(false);
  };

  return (
    <UtilityPanel title="Traceroute" subtitle="Hop path to target" layout="split">
      <UtilitySplitPane
        leftWidth="300px"
        left={
          <div className="space-y-3">
            <Field label="Hostname / IP">
              <TextInput value={host} onChange={(e) => setHost(e.target.value)} />
            </Field>
            <PrimaryButton onClick={run} disabled={loading || !host.trim()} className="w-full">
              {loading ? "Tracing…" : "Trace"}
            </PrimaryButton>
          </div>
        }
        right={
          <>
            {!data && <ResultsPlaceholder text="Enter a target and run traceroute" />}
            {data && !data.available && (
              <UtilityUnavailable message={data.error || data.message || "Data unavailable on this host"} />
            )}
            {data?.hops?.length > 0 && (
              <DataTable
                columns={[
                  { key: "hop", label: "Hop" },
                  { key: "address", label: "Address" },
                  { key: "latency_ms", label: "Latency ms" },
                ]}
                rows={data.hops}
              />
            )}
          </>
        }
      />
    </UtilityPanel>
  );
}

function FirewallStatusPanel() {
  const fetcher = useCallback(() => utilitiesApi.firewall(), []);
  const { loading, data } = useLoad(fetcher);
  if (loading) return <Loading />;
  if (!data?.available) {
    return <UtilityUnavailable message={data?.message || "Data unavailable on this host"} />;
  }
  return (
    <UtilityPanel
      title="Firewall Status"
      subtitle="Verified host firewall tooling only"
      layout="compact"
    >
      <UtilityStatusCard
        title="Firewall"
        status={data.active === true ? "healthy" : data.active === false ? "warning" : undefined}
        pairs={[
          ["Technology", data.technology],
          ["Status", data.status],
          ["Active", data.active === true ? "Yes" : data.active === false ? "No" : null],
          ["Rule count", data.rule_count],
          ["Rule lines", data.rule_lines],
        ]}
      />
    </UtilityPanel>
  );
}

/* ─── Security ─── */

function FailedLoginAlertsPanel() {
  const fetcher = useCallback(() => utilitiesApi.failedLogins(), []);
  const { loading, data } = useLoad(fetcher);
  if (loading) return <Loading />;
  if (!data?.available) {
    return <UtilityUnavailable message={data?.message || "Data unavailable on this host"} />;
  }
  return (
    <UtilityPanel
      title="Failed Login Alerts"
      subtitle="Grouped authentication failures from host logs"
      status={data.status}
      layout="dashboard"
    >
      {hasValue(data.total) && (
        <div className="mb-2">
          <CompactMetricCard label="Total failed events" value={data.total} status={data.status} emphasize />
        </div>
      )}
      {data.groups?.length > 0 && (
        <DataTable
          columns={[
            { key: "user", label: "User" },
            { key: "source_ip", label: "Source IP" },
            { key: "count", label: "Count" },
            { key: "last_seen", label: "Last seen" },
            { key: "method", label: "Method" },
          ]}
          rows={data.groups}
        />
      )}
    </UtilityPanel>
  );
}

function SshLoginTrackerPanel() {
  const fetcher = useCallback(() => utilitiesApi.sshLogins(), []);
  const { loading, data } = useLoad(fetcher);
  if (loading) return <Loading />;
  if (!data?.available || !data.sessions?.length) {
    return <UtilityUnavailable message={data?.message || "Data unavailable on this host"} />;
  }
  return (
    <UtilityPanel title="SSH Login Tracker" subtitle="Successful sessions when available" layout="dashboard">
      <DataTable
        columns={[
          { key: "user", label: "User" },
          { key: "source_ip", label: "Source IP" },
          { key: "login_time", label: "Login time" },
          { key: "time", label: "Time" },
          { key: "method", label: "Method" },
        ]}
        rows={data.sessions}
      />
    </UtilityPanel>
  );
}

function SslCertificateCheckerPanel() {
  const [host, setHost] = useState("");
  const [port, setPort] = useState(443);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);

  const run = async () => {
    setLoading(true);
    const res = await utilitiesApi.ssl({ host, port: Number(port) });
    setData(res.data);
    setLoading(false);
  };

  return (
    <UtilityPanel
      title="SSL Certificate Checker"
      subtitle="Validates certificate with system trust store (no bypass)"
      status={data?.status}
      layout="split"
    >
      <UtilitySplitPane
        left={
          <div className="space-y-3">
            <Field label="Hostname / domain">
              <TextInput
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="example.com"
              />
            </Field>
            <Field label="Port">
              <TextInput type="number" value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
            <PrimaryButton onClick={run} disabled={loading || !host.trim()} className="w-full">
              {loading ? "Checking…" : "Check"}
            </PrimaryButton>
          </div>
        }
        right={
          <>
            {!data && <ResultsPlaceholder text="Enter a hostname and check the certificate" />}
            {data && !data.available && (
              <UtilityUnavailable message={data.error || data.message || "Data unavailable on this host"} />
            )}
            {data?.available && (
              <div className="space-y-3">
                {hasValue(data.days_remaining) && (
                  <CompactMetricCard
                    label="Days remaining"
                    value={data.days_remaining}
                    status={data.status}
                    emphasize
                  />
                )}
                <UtilityStatusCard
                  title="Certificate"
                  status={data.status}
                  pairs={[
                    ["Valid", data.valid === true ? "Yes" : data.valid === false ? "No" : null],
                    [
                      "Hostname verified",
                      data.hostname_ok === true ? "Yes" : data.hostname_ok === false ? "No" : null,
                    ],
                    ["Subject", data.subject],
                    ["Issuer", data.issuer],
                    ["Expires", data.expires],
                    ["TLS version", data.tls_version],
                    ["Error", data.error],
                  ]}
                />
              </div>
            )}
          </>
        }
      />
    </UtilityPanel>
  );
}

/* ─── Inventory ─── */

function SoftwareInventoryPanel() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const fetcher = useCallback(() => utilitiesApi.software(query, 200), [query]);
  const { loading, data } = useLoad(fetcher);

  return (
    <UtilityPanel
      title="Software Inventory"
      subtitle="Installed packages from host package manager"
      layout="dashboard"
    >
      <div className="mb-3 flex max-w-xl flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Field label="Filter">
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="package name contains…"
              onKeyDown={(e) => {
                if (e.key === "Enter") setQuery(search.trim());
              }}
            />
          </Field>
        </div>
        <PrimaryButton onClick={() => setQuery(search.trim())}>Search</PrimaryButton>
      </div>
      {loading && <Loading />}
      {!loading && (!data?.available || !data.packages?.length) && (
        <UtilityUnavailable message={data?.message || data?.error || "Data unavailable on this host"} />
      )}
      {!loading && data?.packages?.length > 0 && (
        <>
          <p className="mb-2 text-xs text-[#64748b]">
            Showing {data.packages.length}
            {hasValue(data.total) ? ` of ${data.total}` : ""}
            {data.package_manager ? ` · ${data.package_manager}` : ""}
            {data.truncated ? " · truncated" : ""}
          </p>
          <DataTable
            columns={[
              { key: "name", label: "Package" },
              { key: "version", label: "Version" },
              { key: "source", label: "Source" },
            ]}
            rows={data.packages}
            dense
          />
        </>
      )}
    </UtilityPanel>
  );
}

function UserAccountReportPanel() {
  const fetcher = useCallback(() => utilitiesApi.users(), []);
  const { loading, data } = useLoad(fetcher);
  if (loading) return <Loading />;
  if (!data?.available) {
    return <UtilityUnavailable message={data?.message || "Data unavailable on this host"} />;
  }
  return (
    <UtilityPanel
      title="User Account Report"
      subtitle="Human accounts emphasized — no password data"
      layout="dashboard"
    >
      {hasValue(data.system_account_count) && (
        <p className="mb-3 text-xs text-[#64748b]">
          System/service accounts: {data.system_account_count} (not listed)
        </p>
      )}
      {data.human_users?.length > 0 ? (
        <DataTable
          columns={[
            { key: "username", label: "Username" },
            { key: "uid", label: "UID" },
            { key: "shell", label: "Shell" },
            { key: "home", label: "Home" },
            { key: "login_enabled", label: "Login" },
            { key: "last_login", label: "Last login" },
          ]}
          rows={data.human_users.map((u) => ({
            ...u,
            login_enabled:
              u.login_enabled === true ? "enabled" : u.login_enabled === false ? "disabled" : null,
          }))}
        />
      ) : (
        <UtilityUnavailable message="No human user accounts to display" />
      )}
    </UtilityPanel>
  );
}

/* ─── Operations ─── */

function BackupStatusPanel() {
  const fetcher = useCallback(() => utilitiesApi.backup(), []);
  const { loading, data } = useLoad(fetcher);
  if (loading) return <Loading />;
  if (!data?.available) {
    return <UtilityUnavailable message={data?.message || "Backup status unavailable"} />;
  }
  return (
    <UtilityPanel
      title="Backup Status"
      subtitle="Only verified configuration/tooling — success never assumed"
      layout="compact"
    >
      <div className="max-w-3xl">
        <DataTable
          columns={[
            { key: "system", label: "System" },
            { key: "source", label: "Source" },
            { key: "status", label: "Status" },
            { key: "config", label: "Config" },
            { key: "detail", label: "Detail" },
          ]}
          rows={data.findings || []}
          dense
        />
      </div>
      {data.verified_success === false && (
        <p className="mt-3 max-w-3xl text-xs text-[#64748b]">
          No verified successful backup completion was confirmed from available signals.
        </p>
      )}
    </UtilityPanel>
  );
}

function BroadcastMessagePanel() {
  const [message, setMessage] = useState("");
  const [severity, setSeverity] = useState("maintenance");
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const send = async () => {
    if (!confirm) return;
    setLoading(true);
    const res = await utilitiesApi.broadcast({ message, severity, confirm: true });
    setResult(res.data);
    setLoading(false);
  };

  const preview = message.trim() ? `[FBL ${severity.toUpperCase()}] ${message.trim()}` : "";

  return (
    <UtilityPanel
      title="Broadcast Message"
      subtitle="Sends wall message to logged-in users — confirmation required"
      layout="split"
    >
      <UtilitySplitPane
        leftWidth="380px"
        left={
          <div className="space-y-3">
            <Field label="Message">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                maxLength={500}
                className="w-full rounded-lg border bg-[rgba(8,12,18,0.9)] px-3 py-2 text-sm text-[#f1f5f9]"
                style={{ borderColor: "rgba(34,211,238,0.18)" }}
              />
            </Field>
            <Field label="Severity">
              <SelectInput value={severity} onChange={(e) => setSeverity(e.target.value)}>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
                <option value="maintenance">Maintenance</option>
              </SelectInput>
            </Field>
            <label className="flex items-start gap-2 text-xs text-[#94a3b8]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />
              I confirm this message should be broadcast to logged-in users
            </label>
            <PrimaryButton
              onClick={send}
              disabled={loading || !confirm || !message.trim()}
              className="w-full"
            >
              {loading ? "Sending…" : "Send broadcast"}
            </PrimaryButton>
          </div>
        }
        right={
          <div className="space-y-3">
            {preview ? (
              <div
                className="rounded-lg border px-3 py-2 text-sm text-[#e2e8f0]"
                style={{ borderColor: "rgba(34,211,238,0.15)", background: "rgba(8,12,18,0.85)" }}
              >
                <div className="mb-1 text-[10px] uppercase tracking-wider text-[#64748b]">Preview</div>
                {preview}
              </div>
            ) : (
              <ResultsPlaceholder text="Compose a message to preview and send" />
            )}
            {result && (
              <UtilityStatusCard
                title="Delivery"
                status={result.success ? "healthy" : "critical"}
                pairs={[
                  ["Result", result.success ? "Sent successfully" : "Failed to send"],
                  ["Timestamp", result.timestamp],
                  ["Error", result.error],
                ]}
              />
            )}
          </div>
        }
      />
    </UtilityPanel>
  );
}

function EmailAlertsPanel() {
  const fetcher = useCallback(() => fetchEmailStatus(), []);
  const { loading, data, reload } = useLoad(fetcher);
  if (loading) return <Loading />;

  const enabled = Boolean(data?.enabled);
  const last = data?.last_alert;
  const lastLabel = last
    ? [
        last.component || last.metric || last.fault_id,
        last.type === "warning_alert"
          ? "WARNING"
          : last.type === "critical_alert"
            ? "CRITICAL"
            : last.type,
        last.timestamp_label || null,
      ]
        .filter(Boolean)
        .join(" — ")
    : null;

  const delivery =
    last?.status === "sent"
      ? "Email: Sent"
      : last?.status === "failed"
        ? "Email: Failed"
        : !enabled
          ? "Email: Not configured"
          : null;

  return (
    <UtilityPanel
      title="Email Alerts"
      subtitle="WARNING/CRITICAL notifications via backend SMTP (credentials never exposed here)"
      layout="compact"
      actions={
        <button
          type="button"
          className="text-xs font-medium text-[#38bdf8] hover:text-[#22d3ee]"
          onClick={reload}
        >
          Refresh
        </button>
      }
    >
      <UtilityGrid columns="auto">
        <CompactMetricCard
          label="Status"
          value={enabled ? "Enabled" : "Disabled"}
          emphasize={enabled}
        />
        <CompactMetricCard
          label="Channel"
          value={data?.channel || "email"}
        />
        <CompactMetricCard
          label="Recipient"
          value={data?.recipient_masked || "—"}
        />
      </UtilityGrid>
      <div
        className="mt-3 rounded-xl border px-3 py-2 text-xs text-[#94a3b8]"
        style={{ borderColor: "rgba(34,211,238,0.12)", background: "rgba(8,12,18,0.75)" }}
      >
        <p>{data?.message || "Email notifications disabled/not configured"}</p>
        <p className="mt-1 text-[#64748b]">
          Last Alert: {lastLabel || "None recorded"}
          {delivery ? ` · ${delivery}` : ""}
        </p>
        <p className="mt-2 text-[10px] leading-relaxed text-[#64748b]">
          WARNING and CRITICAL each send one email. Escalation from WARNING to CRITICAL
          sends one additional CRITICAL email. Repeats are suppressed until the fault
          recovers. Configure EMAIL_* / SMTP_* on the Flask host — never in the browser.
        </p>
      </div>
    </UtilityPanel>
  );
}

function IncidentAnalysisUtilitiesPage() {
  return (
    <UtilityPanel
      title="Incident Analysis Utilities"
      subtitle="Allowlisted diagnostics for an active incident. Prefer opening these from Active Fault Log so runs are associated with the fault id."
      layout="dashboard"
    >
      <IncidentAnalysisArchitecture />
      <div className="mt-4">
        <IncidentAnalysisPanel incidentId={null} />
      </div>
    </UtilityPanel>
  );
}

function DailyReportPanel({ onOpenReports }) {
  const [format, setFormat] = useState("pdf");
  const [range, setRange] = useState("24h");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const generate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await generateReport(
        {
          intervalKey: range,
          title: "FBL Daily Infrastructure Report",
          sections: DEFAULT_SECTION_SELECTION,
          generatedBy: "Utilities · Daily Report",
        },
        [format],
        () => {}
      );
      if (result?.outputs) {
        downloadFormatOutput(result.outputs, format);
        setMessage(`Generated ${format.toUpperCase()} for ${range}`);
      } else {
        setMessage(result?.error || "Report generation failed");
      }
    } catch (err) {
      setMessage(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <UtilityPanel
      title="Daily Report"
      subtitle="Uses existing SQLite /reports/data pipeline — never live /metrics as history"
      layout="compact"
      actions={
        <button
          type="button"
          className="text-xs font-medium text-[#38bdf8] hover:text-[#22d3ee]"
          onClick={() => onOpenReports?.()}
        >
          Open full Reports →
        </button>
      }
    >
      <div
        className="max-w-md space-y-2.5 rounded-lg border p-3"
        style={{ background: "rgba(8,12,18,0.88)", borderColor: "rgba(34,211,238,0.14)" }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Range">
            <SelectInput value={range} onChange={(e) => setRange(e.target.value)}>
              <option value="1h">Last 1 Hour</option>
              <option value="6h">Last 6 Hours</option>
              <option value="24h">Last 24 Hours</option>
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
            </SelectInput>
          </Field>
          <Field label="Format">
            <SelectInput value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="pdf">PDF</option>
              <option value="docx">DOCX</option>
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
            </SelectInput>
          </Field>
        </div>
        <PrimaryButton onClick={generate} disabled={busy} className="w-full">
          {busy ? "Generating…" : "Generate report"}
        </PrimaryButton>
        {message && <p className="text-sm text-[#94a3b8]">{message}</p>}
      </div>
    </UtilityPanel>
  );
}

export function UtilityWorkspace({ utilityId, onOpenReports }) {
  switch (utilityId) {
    case "server-uptime":
      return <ServerUptimePanel />;
    case "disk-usage":
      return <DiskUsagePanel />;
    case "find-large-files":
      return <FindLargeFilesPanel />;
    case "temperature-fan":
      return <TemperatureFanPanel />;
    case "reboot-history":
      return <RebootHistoryPanel />;
    case "ping-node":
      return <PingNodePanel />;
    case "packet-loss":
      return <PacketLossPanel />;
    case "port-scanner":
      return <PortScannerPanel />;
    case "traceroute":
      return <TraceroutePanel />;
    case "firewall-status":
      return <FirewallStatusPanel />;
    case "failed-login-alerts":
      return <FailedLoginAlertsPanel />;
    case "ssh-login-tracker":
      return <SshLoginTrackerPanel />;
    case "ssl-certificate-checker":
      return <SslCertificateCheckerPanel />;
    case "software-inventory":
      return <SoftwareInventoryPanel />;
    case "user-account-report":
      return <UserAccountReportPanel />;
    case "backup-status":
      return <BackupStatusPanel />;
    case "broadcast-message":
      return <BroadcastMessagePanel />;
    case "email-alerts":
      return <EmailAlertsPanel />;
    case "daily-report":
      return <DailyReportPanel onOpenReports={onOpenReports} />;
    case "incident-analysis-utilities":
      return <IncidentAnalysisUtilitiesPage />;
    default:
      return <UtilityUnavailable message="Select a utility from the tree" />;
  }
}
