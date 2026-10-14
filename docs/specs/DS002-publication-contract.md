---
title: DS002-publication-contract
summary: Defines immutable source selection, proof ownership, and promotion boundaries.
---

## Introduction

Each publishing workflow owns its accepted inputs and evidence.

## Core Content

A workflow must validate its declared source and image identities before the dependent operation. Exact-SHA and digest requirements are workflow-specific and must not be weakened by a generic example. Ploinky Box resolves its library commits once per publication and supplies those commits to every native build.

A proof or receipt establishes only the checks its verifier actually performs. Acceptance receipts must be retained with their referenced test reports. Moving stable tags and changing consumer manifests remain separate authorized operations. Secrets must be supplied through the declared credential channels and must not appear in documentation or proof files.

The Bizanso runtime build context must contain only public runtime definitions, a locked npm dependency tree, and the pinned public model selection. No private application checkout, account data, or workspace credential enters the image. Each native digest must pass the network-isolated runtime gate before assembly. Saved proof must bind architecture, image digest, workflow SHA, run and attempt, base digest, package-lock hash, and model revision. The stable tag moves only through explicit promotion. Private application source is mounted read-only by the consumer outside the runtime's dependency and model directories.
