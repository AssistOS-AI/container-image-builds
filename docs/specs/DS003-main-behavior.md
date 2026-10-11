---
title: DS003-main-behavior
summary: Defines source selection, candidate verification, and stable image promotion.
---

## Introduction

Operators use the repository to produce and adopt verifiable runtime images.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Build from selected inputs | A selected workflow assembles an image from its Dockerfile and validated source inputs. |
| Verify and publish candidates | Workflow-specific checks bind native results and candidate digests to their inputs. |
| Promote accepted images | Explicit promotion moves stable aliases after the required evidence is accepted. |

### Build from selected inputs

An operator selects an image workflow and its declared inputs. The workflow resolves source revisions, prepares the appropriate build context, and builds the selected architectures. Ploinky Box freezes library revisions once for all native builds. Pinned source clones are inputs and must not be edited as application source.

### Verify and publish candidates

The workflow runs its image-specific checks and records the resulting identities and proof. A [candidate](wiki.html#definition-candidate) is addressed by immutable digest. Static repository tests and Dockerfile inspection do not substitute for native runtime evidence.

### Promote accepted images

An explicit [promotion](wiki.html#definition-promotion) operation checks the required candidate evidence and then updates stable registry aliases. Ploinky Box promotion also validates an [acceptance receipt](wiki.html#definition-acceptance-receipt) against the saved publication identity. Consumers adopt a new digest through a separate manifest change.
