# Spec Delta: desktop-dist

## Purpose

Reproducible, one-command production of a distributable DeepSeek Harness desktop artifact for the build machine's architecture, plus the release contract around it: artifact identity, version and architecture gates, checksum anchoring, and the documented path from build to GitHub Release to receiver's machine.

## ADDED Requirements

### Requirement: One command produces the distributable artifact

A single documented command SHALL take a checkout from unbuilt to a distribution-ready artifact, running every intermediate step (workspace build, runtime deploy, app assembly, packaging) itself, and SHALL be safe to run repeatedly.

#### Scenario: build from a clean checkout

- **WHEN** the command runs on a checkout that has never produced desktop build outputs, with only the documented prerequisites installed
- **THEN** it completes without manual intermediate steps and produces both the assembled `.app` and the distribution archive

#### Scenario: rerun after success

- **WHEN** the command runs again after a successful run
- **THEN** it succeeds and replaces the previous artifacts, leaving no output from the earlier run

### Requirement: The archive carries the complete self-contained app

The distribution archive SHALL contain the runtime-injected, re-signed `.app` exactly as it exists after assembly, preserving the runtime tree's symbolic links as links; the expanded application SHALL run on a machine without the repository checkout.

#### Scenario: expansion preserves the runtime symlink layout

- **WHEN** the archive is expanded on another machine
- **THEN** the runtime tree's internal symbolic links remain symbolic links, because the bundle's module resolution depends on that layout

#### Scenario: expanded app runs without the repo

- **WHEN** the expanded `.app` is launched on a stock machine of the build architecture with no repository checkout
- **THEN** the application starts, spawns its host, and opens its window

### Requirement: Artifact identity encodes version and architecture, gated at entry

The distribution archive name SHALL encode the desktop version and the build architecture. The two files that each record the desktop version SHALL agree, and the build SHALL run only on the x64 host architecture; a disagreement or an unsupported architecture SHALL fail the build before any step runs, with a diagnostic naming the offending values.

#### Scenario: naming follows version and architecture

- **WHEN** a build succeeds for desktop version `0.1.0` on an x64 host
- **THEN** the artifact is named `dsh-desktop_0.1.0_x64.zip`

#### Scenario: version disagreement fails the build

- **WHEN** the desktop version recorded in the Tauri config and the version recorded in the Rust manifest disagree
- **THEN** the command fails with a diagnostic naming both values, and no archive is produced

#### Scenario: unsupported host architecture fails the build

- **WHEN** the command runs on a host whose build architecture is not x64
- **THEN** it fails with a diagnostic naming the reported architecture, and no step or artifact runs before the failure

### Requirement: Distribution steps are documented for the maintainer and the receiver

The desktop documentation SHALL describe the full distribution flow: producing the artifact, attaching it with its SHA-256 checksum to a GitHub Release, and the first-launch steps a receiver of the unsigned build must take when Gatekeeper blocks it.

#### Scenario: maintainer publishes a release

- **WHEN** a maintainer follows the documented flow after a successful dist build
- **THEN** the artifact and its SHA-256 checksum are attached to a GitHub Release of the documented repository, under the documented desktop tag scheme

#### Scenario: receiver verifies download integrity

- **WHEN** a receiver compares a downloaded archive against the checksum published in the release
- **THEN** the documentation shows the command that performs the comparison

#### Scenario: receiver gets past the unsigned-build block

- **WHEN** a receiver launches the expanded application for the first time and Gatekeeper blocks the unsigned build
- **THEN** the documentation tells them how to proceed (open via the Finder confirm dialog, or clear the quarantine attribute)
