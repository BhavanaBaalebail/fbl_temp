/**
 * Topology Service
 * Handles hardware topology data, connectivity information, and real-time updates
 * Prepared for backend integration
 */

import { apiRequest } from "./api";
import {
  cpuLinks,
  gpuLinks,
  ramLinks,
  diskLinks,
  psuLinks,
  nicLinks,
  ioCtrlLinks,
  ManagementLinks,
} from "../data/topologyData";

/**
 * Fetch full system topology
 * TODO: GET /api/topology - Get complete hardware topology
 * TODO: Implement topology caching with invalidation
 * TODO: Add topology change detection
 */
export async function fetchSystemTopology() {
  // TODO: Implement actual API call
  // const response = await apiRequest('/topology');
  // return response.data;

  console.warn("TODO: Replace with API call to GET /api/topology");
  return {
    cpu: cpuLinks,
    gpu: gpuLinks,
    ram: ramLinks,
    disk: diskLinks,
    psu: psuLinks,
    nic: nicLinks,
    ioController: ioCtrlLinks,
    management: ManagementLinks,
  };
}

/**
 * Get topology for a specific component
 * TODO: GET /api/topology/:componentId - Get component-specific connectivity
 * TODO: Real-time port status updates
 */
export async function getComponentTopology(componentId) {
  // TODO: Implement actual API call
  // const response = await apiRequest(`/topology/${componentId}`);
  // return response.data;

  const topologyMap = {
    CPU: cpuLinks,
    GPU: gpuLinks,
    RAM: ramLinks,
    DISK: diskLinks,
    PSU: psuLinks,
    NIC: nicLinks,
    "IO Controller": ioCtrlLinks,
    Management: ManagementLinks,
  };

  console.warn("TODO: Replace with API call to GET /api/topology/:componentId");
  return topologyMap[componentId] || [];
}

/**
 * Subscribe to topology changes
 * TODO: WebSocket /topology/subscribe - Stream hardware changes
 * TODO: Auto-detect hardware additions/removals
 * TODO: Track interface state changes
 */
export function subscribeTopologyUpdates(callback) {
  // TODO: Implement WebSocket subscription
  // const ws = new WebSocket(`${WS_URL}/topology`);
  // ws.onmessage = (event) => {
  //   const topologyChange = JSON.parse(event.data);
  //   callback(topologyChange);
  // };
  // return () => ws.close();

  console.warn("TODO: Implement WebSocket subscription to /topology");
  return () => {}; // Return no-op unsubscribe function
}

/**
 * Get interface connectivity details
 * TODO: GET /api/topology/:componentId/interfaces - Detailed port info
 * TODO: Include bandwidth, latency, error rates
 */
export async function getInterfaceDetails(componentId, interfaceId) {
  // TODO: Implement actual API call
  // const response = await apiRequest(
  //   `/topology/${componentId}/interfaces/${interfaceId}`
  // );
  // return response.data;

  console.warn(
    `TODO: Replace with API call to GET /api/topology/${componentId}/interfaces/${interfaceId}`
  );
  return null;
}

/**
 * Get link health metrics
 * TODO: GET /api/topology/links/:linkId/health - Link quality metrics
 * TODO: Include error rates, latency, throughput
 */
export async function getLinkHealthMetrics(linkId) {
  // TODO: Implement actual API call
  // const response = await apiRequest(`/topology/links/${linkId}/health`);
  // return response.data;

  console.warn(`TODO: Replace with API call to GET /api/topology/links/${linkId}/health`);
  return {
    linkId,
    errorRate: 0,
    latency: 0,
    throughput: 0,
    status: "healthy",
  };
}
