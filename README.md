# Framework Block Ledger (FBL)

## Overview

Framework Block Ledger (FBL) is a centralized architectural visualization and fault analysis framework designed to help L2/L3 Support Engineers understand, monitor, and troubleshoot application-to-infrastructure connectivity.

The system models relationships between hardware and infrastructure components such as CPU, GPU, RAM, Disk, Power Supply Unit (PSU), Network Interface Card (NIC), I/O Controller, and Management Controller.

The framework provides:

* Connectivity visualization between components
* Component health monitoring
* Fault detection and impact analysis
* Self-healing and remediation workflows
* Infrastructure dependency tracking
* Root cause analysis support


## Problem Statement

In large-scale systems:

* Port dependencies are not centrally documented
* Service-to-socket mappings are distributed across infrastructure layers
* Troubleshooting requires manual correlation across multiple teams
* Firewall and protocol tracing consume significant time during incidents

Framework Block Ledger addresses these challenges by providing a unified view of component connectivity, health, fault propagation, and recovery workflows.


## Features Implemented

### Dashboard

* Component health overview
* Fault severity distribution
* Active fault statistics
* Recovery metrics
* System uptime visualization

### Connectivity View

* Interactive topology map
* Hardware dependency visualization
* Protocol and interface mapping
* Communication path tracing

### Fault Detection

* Fault categorization by component
* Critical, Warning, and Resolved fault tracking
* Impact analysis
* Fault investigation workflow

### Self-Healing Simulation

* Auto-healing workflow visualization
* Failover process simulation
* Recovery phase tracking
* Remediation action plans


## Technologies Used

### Frontend

* React.js
* Vite
* Tailwind CSS
* Recharts

### Planned Backend

* Python
* Java
* Shell Scripting

### Future Integrations

* REST APIs
* WebSocket/SSE Event Streaming
* Hardware Telemetry Collection
* Fault Correlation Engine
* Topology Discovery Service


## Components Modeled

* CPU
* GPU
* RAM
* Disk
* PSU (Power Supply Unit)
* NIC (Network Interface Card)
* I/O Controller
* Management Controller (BMC)

## Current Status

This version is a frontend prototype containing:

* Static mock data
* Simulated faults
* Simulated connectivity mappings
* Simulated self-healing workflows

No backend integration has been implemented yet.

---

## Future Work

### Phase 1

* Component Health Poller
* Dashboard API Integration

### Phase 2

* Fault Detection Engine
* Real-time Fault Streaming

### Phase 3

* Dynamic Topology Discovery

### Phase 4

* Automated Self-Healing Engine

### Phase 5

* Multi-System Monitoring
* Fleet-wide Analysis


## Project Goal

To create a reusable Framework Block Ledger that standardizes connectivity governance, accelerates troubleshooting, enables proactive fault detection, and supports intelligent self-healing workflows.
