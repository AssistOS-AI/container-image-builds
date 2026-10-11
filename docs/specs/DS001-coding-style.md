---
title: DS001-coding-style
summary: Defines image, workflow, helper, and test organization.
---

## Introduction

Build definitions and verification helpers have separate responsibilities.

## Core Content

Dockerfiles and their image-specific helpers belong beneath `images/<image>/`. Publishing workflows belong beneath `.github/workflows/`. Node helper modules use `.mjs` and built-in modules where suitable. Existing shell and C helpers retain their documented roles. Tests belong beneath `tests/`, with reusable data beneath `tests/fixtures/`.

A documentation check must not publish, promote, or deploy an image. Runtime and registry claims require the workflow-specific evidence. Dependency exceptions and toolchain choices are recorded in `dependencies.md` and applicable source locks.
