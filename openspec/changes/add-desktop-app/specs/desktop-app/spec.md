# Spec Delta: desktop-app

## Purpose

The desktop application shell: a native window around the harness web surface, owning the lifecycle of a private host process. This capability covers what operators and the host can rely on — launch, handshake, window binding, single instance, and teardown — independent of shell toolkit choice.

## ADDED Requirements

### Requirement: Desktop launch starts a private host and opens a window on it

Launching the desktop application starts one private harness web host with an OS-assigned port and opens a native window whose content is the web surface served by that host.

#### Scenario: normal launch

- **WHEN** the desktop application is launched
- **THEN** exactly one host process is started with an OS-assigned loopback port, and the window loads the web surface from that port

#### Scenario: host startup failure is surfaced

- **WHEN** the host process fails, or does not announce its serving URL within a bounded startup window
- **THEN** the application presents a visible error state naming the failure, instead of a blank or indefinitely loading window

### Requirement: The host announces itself over a machine-readable startup line

The host announces its serving URL on stdout as a single line of the existing `dsh web: <url>` form; that line is the handshake contract between host and shell.

#### Scenario: shell reads the announcement

- **WHEN** the host becomes ready to serve
- **THEN** it emits exactly one stdout line from which the serving URL can be parsed, and the shell navigates the window using that URL

### Requirement: The window talks to the host through the loopback HTTP surface only

The desktop window loads the web surface from the host's loopback HTTP URL; the application introduces no other request path to the host API.

#### Scenario: trust fence compatibility

- **WHEN** the web surface running in the desktop window makes API requests
- **THEN** they succeed without any change to the host's browser-trust fence, because every request carries the loopback Host of the announced URL

### Requirement: External web links open in the system browser

Activating a link to an external http(s) page inside the window opens it in the user's default system browser; the window's own content is unchanged.

#### Scenario: search citation link

- **WHEN** the user activates an external http(s) link rendered in the web surface, such as a web-search citation
- **THEN** the target opens in the system default browser, and the desktop window keeps its current content

### Requirement: Client-side persisted state survives ordinary restarts

Across ordinary application restarts, the private host binds a stable port so browser storage keyed by origin — input drafts, last-selected session, workspace view — carries over. A launch on which the stable port is unavailable falls back to an OS-assigned port rather than failing.

#### Scenario: restart preserves drafts

- **WHEN** the user types an unfinished prompt, quits, and relaunches
- **THEN** the draft reappears in the input, because the origin is unchanged

#### Scenario: port already taken

- **WHEN** the stable port is held by another process at launch
- **THEN** the application still launches via an OS-assigned port (client-side persisted state does not carry over for that session; the condition is observable, not silent data loss)

### Requirement: The application is single-instance

A second launch of the desktop application does not start a second host or a second window; it focuses the existing window.

#### Scenario: second launch

- **WHEN** the desktop application is already running and it is launched again
- **THEN** the existing window is brought to the front and no additional host process is created

### Requirement: Quitting the application terminates the host

When the user quits the desktop application, the private host process is terminated as part of shutdown, and no host process belonging to that launch survives the quit.

#### Scenario: normal quit

- **WHEN** the user quits the application while a session is idle
- **THEN** the host process exits during shutdown and is not present after the application has quit

#### Scenario: quit during an active agent turn

- **WHEN** the user quits the application while an agent turn is streaming
- **THEN** the host receives a termination signal it already handles for graceful drain, and still exits within a bounded shutdown window
