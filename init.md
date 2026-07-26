# Mango Tango Ranking App — Implementation Scope

## 1. Purpose

Build a lightweight, mobile-first web application for ranking mango varieties during the annual Mango Tango event.

Guests should be able to open the app, immediately see the currently available mangoes, rate them without creating an account, and submit their completed rankings under a name.

The application should remain synchronized throughout the event so that:

* Newly added or edited mangoes appear promptly.
* Removed or unavailable mangoes disappear promptly.
* A guest’s ratings are saved automatically.
* Guests do not continue rating against stale event data.
* Hosts can monitor submissions and update the event from an admin interface.

## 2. Primary Users

### Guests

Guests use the public application primarily from mobile phones.

They should not need to:

* Create an account
* Enter an email address
* Choose a password
* Explicitly save each rating

A browser-generated client identifier maintains continuity for that browser.

### Hosts

Hosts use a password-protected admin interface to:

* Add mango varieties
* Edit mango names and descriptions
* Reorder mangoes
* Mark mangoes available or unavailable
* Monitor participant and submission activity
* Open or close ranking
* View or export event results

## 3. Core Architecture

Each Mango Tango event is represented by a single Cloudflare Durable Object.

The Durable Object acts as the authoritative, real-time coordinator for:

* Event configuration
* Mango varieties
* Participant sessions
* Draft rankings
* Final submissions
* Connected clients
* Live event updates

The Durable Object uses its attached SQLite storage for persistent event data.

The public application and admin application communicate with the Durable Object through a Worker API. Live updates are delivered through a persistent real-time connection, with ordinary request-based synchronization available as a fallback.

## 4. Guest Experience

### Initial Visit

When a guest opens the app:

1. The browser generates a random `clientId` if one does not already exist.
2. The `clientId` is stored locally in the browser.
3. The app connects to the current event.
4. The server returns:

   * Event status
   * Current mango list
   * Existing rankings associated with that `clientId`
   * Submission status
5. The guest can begin ranking immediately.

The `clientId` is an anonymous continuity token, not an authenticated identity.

Clearing browser storage, using another browser, or using private browsing may create a new participant session.

### Mango List

The main interface is a vertically scrolling list of mango varieties.

Each collapsed mango row shows:

* Mango name
* Optional short identifier or number
* Current rating, when already rated
* Clear visual indication of whether the mango still needs to be rated

Tapping a mango expands it to show:

* Full description
* Rating slider from 1 through 10
* Current numerical score
* Visual score treatment
* Saved or saving status

The mobile interface should use large touch targets and require no precision gestures.

### Rating Scale

The slider represents:

* `1`: worst
* `10`: best

The selected rating should be communicated through more than color alone. It should always include the numerical value and may include a short textual label.

The visual scale may progress through colors such as:

* Low: brown or muted
* Lower-middle: yellow
* Middle: yellow-green
* High: green
* Highest: mango-inspired red and green

The exact palette should maintain sufficient contrast and avoid relying exclusively on red-versus-green distinctions.

### Autosave

Ratings are saved automatically.

The application should:

* Update the interface immediately when the slider moves
* Save after the guest finishes or pauses interaction
* Avoid sending a request for every intermediate slider position
* Retry transient failures
* Clearly indicate `Saving`, `Saved`, or `Offline`
* Reconcile with the server after reconnecting

The server remains authoritative when local and server state conflict.

### Submission

A guest may submit once they have provided the required ratings.

At submission time:

1. The app identifies any currently available mangoes that remain unrated.
2. The guest is prompted for a display name.
3. The app shows a compact confirmation summary.
4. The completed rankings are submitted as a finalized snapshot.
5. The guest sees a clear success state.

The system should preserve both:

* The guest’s latest draft rankings
* The exact ranking snapshot associated with the submission

Whether guests may revise and resubmit should be an event-level configuration. The initial version may allow hosts to choose between:

* One final submission per client
* Resubmission that replaces the active submission while retaining history

## 5. Real-Time Behavior

Connected guest and admin clients should receive live event updates.

Real-time messages may include:

* Mango added
* Mango edited
* Mango reordered
* Mango made unavailable
* Mango restored
* Ranking opened
* Ranking closed
* Results visibility changed
* Submission count changed

When the mango list changes, the guest interface should update without a page reload.

### New Mango During the Event

When a host adds a mango:

* It appears for connected guests.
* It begins in an unrated state.
* Previously submitted entries remain historically valid.
* The app clearly indicates that a new mango has been added.

The host may optionally require the new mango for future submissions.

### Mango Removed During the Event

Removing a mango should normally mean marking it unavailable rather than deleting it.

An unavailable mango:

* Disappears from the active guest list
* Retains existing ratings and submission history
* Can be restored by an administrator

Permanent deletion should only be available for accidental entries with no meaningful associated data.

### Reconnection and Stale State

Every connection should begin with or be followed by a full authoritative state synchronization.

The protocol should include an event revision or version number so the client can detect missed updates.

If a connection is interrupted:

* Existing ratings remain visible locally.
* Unsaved changes are queued where practical.
* The app attempts to reconnect.
* The complete event state is refreshed after reconnection.
* The guest is warned when changes have not reached the server.

A guest should not unknowingly remain on a stale mango list.

## 6. Admin Interface

The admin interface should be usable from both a phone and a laptop.

### Authentication

The admin area is protected by a shared host password or equivalent lightweight access control.

Successful authentication should create a secure, short-lived admin session. The password should not be stored in browser-visible application code or transmitted with every admin operation.

### Mango Management

Hosts can:

* Add a mango
* Edit its name
* Edit its description
* Change its display order
* Mark it available or unavailable
* Restore an unavailable mango
* See how many draft and submitted ratings reference it

Changes should be broadcast to connected guests immediately.

### Event Controls

Hosts can:

* Open ranking
* Pause or close ranking
* Open or close submissions
* Choose whether all active mangoes must be rated
* Choose whether resubmission is allowed
* Show or hide live results
* Add a brief event message or announcement

### Event Monitoring

The admin dashboard should show:

* Number of connected browsers
* Number of participants with saved ratings
* Number of completed submissions
* Number of ratings per mango
* Mangoes frequently left unrated
* Recent submissions
* Basic connection or save errors

Participant names should only appear after submission.

### Results and Export

Hosts should be able to view:

* Average score by mango
* Median score by mango
* Rating distribution
* Number of ratings
* Ranked results
* Individual submitted ballots
* Draft versus submitted participation counts

Results should be calculated primarily from finalized submissions, with draft data clearly separated.

Hosts should be able to export event data in a conventional format such as CSV or JSON.

## 7. Data Model

The persistent model should cover the following concepts without requiring separate infrastructure:

### Event

* Event identifier
* Event name
* Status
* Submission rules
* Results visibility
* Current revision
* Creation and update times

### Mango

* Stable identifier
* Name
* Description
* Display order
* Availability
* Creation and update times

### Participant

* Client identifier
* First seen time
* Last seen time
* Last connected time
* Current state revision

### Draft Ranking

* Client identifier
* Mango identifier
* Score
* Client revision
* Server update time

### Submission

* Submission identifier
* Client identifier
* Display name
* Submission time
* Submission revision
* Active or superseded status

### Submitted Score

* Submission identifier
* Mango identifier
* Score
* Snapshot of relevant mango metadata where appropriate

## 8. Mobile and Accessibility Requirements

The public application should be designed for one-handed mobile use.

It should include:

* Responsive layout from small phones upward
* Large tap targets
* Minimal typing
* No hover-dependent interactions
* Readable text in outdoor or party lighting
* Persistent indication of save and connection status
* Support for keyboard and assistive navigation
* Numerical and textual score feedback in addition to color
* Reduced-motion compatibility
* Prevention of accidental data loss during refresh or navigation

The interface should remain fast on an ordinary cellular connection and should avoid loading unnecessary assets.

## 9. Reliability and Data Integrity

The backend should:

* Validate every rating as an integer from 1 through 10
* Treat client identifiers as untrusted input
* Make ranking updates idempotent
* Prevent stale writes from silently overwriting newer ones
* Preserve submitted snapshots
* Serialize event-wide state changes through the Durable Object
* Maintain historical data when mangoes are hidden
* Enforce admin authorization server-side
* Apply basic abuse and request-rate protections
* Keep an auditable record of significant admin actions

The application does not need account-grade identity security, but it should prevent obvious accidental duplication, malformed input, and unauthorized administration.

## 10. Out of Scope for the Initial Version

The first version does not require:

* Guest accounts
* Email or SMS verification
* Social login
* Multiple simultaneous events within one Durable Object
* Public user profiles
* Cross-device guest synchronization
* Complex anti-fraud systems
* Payments
* Native mobile applications
* Offline-first editing for extended periods
* Public comments or reviews
* Advanced analytics dashboards
* Automated mango identification
* Multiple administrator roles

The architecture should not prevent future support for multiple events, but the initial implementation may assume one active annual event.

## 11. Acceptance Criteria

The first version is complete when:

1. A guest can open the app on a phone and begin rating without logging in.
2. Ratings survive page refreshes in the same browser.
3. Ratings are automatically persisted and visibly confirmed.
4. A guest can submit a named, finalized ranking.
5. A host can add, edit, reorder, hide, and restore mangoes.
6. Mango changes propagate to connected guests without a manual refresh.
7. Reconnecting clients receive the full current event state.
8. Guests are visibly warned when offline or unsynchronized.
9. Hosts can open and close ranking and submissions.
10. Hosts can view submission progress and aggregate results.
11. Hosts can export the finalized ranking data.
12. Historical submissions remain intact when the active mango list changes.
13. The full event can operate through one Durable Object and its attached persistent storage.
