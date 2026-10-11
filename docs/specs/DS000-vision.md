---
title: DS000-vision
summary: Defines ownership of shared runtime image builds and publishing workflows.
---

## Introduction

The repository supplies the images consumed by Ploinky and agent projects.

## Core Content

Dockerfiles, image helpers, and publishing workflows belong to this repository. Agent application source belongs to its source repository and is consumed through selected revisions. Generated or pinned source checkouts beneath `sources/` must not become an independent source of edits. Build, candidate publication, stable promotion, and consumer adoption are separate operations.
