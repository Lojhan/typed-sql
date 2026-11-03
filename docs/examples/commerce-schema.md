---
title: Shared commerce schema
pageType: reference
description: The users, teams, products, orders, and audit model used throughout typed-sql examples and the playground, adapted for PostgreSQL, MySQL, and SQLite.
---

# Shared commerce schema

The documentation, runnable applications, and playground use one commerce model. Query recipes build on these tables rather than introducing unrelated databases.

| Table | Purpose and relationships |
| --- | --- |
| `users` | Email, display name, account status, profile JSON, and creation time |
| `teams` | Team names and unique slugs |
| `memberships` | Users belong to teams with an owner, admin, or member role |
| `products` | SKU, title, integer price in cents, availability, and optional JSON metadata |
| `orders` | A user's order, status, total in cents, creation time, and optional shipping time |
| `order_items` | Products, quantities, and unit prices belonging to an order |
| `audit_events` | Event names and JSON payloads, optionally associated with a user |

PostgreSQL declares `account_status`, `order_status`, and `membership_role` as enum types. MySQL uses column enums. SQLite uses text with `CHECK` constraints; its inferred types remain `string`.

The schemas include defaults for tutorial inserts and deterministic sample rows. Monetary amounts are integer cents. PostgreSQL and MySQL infer those integer columns as `number`; SQLite's default integer policy uses `bigint`. PostgreSQL timestamp columns and MySQL datetime columns use `Date`, while SQLite stores timestamps as text. JSON inference and decoding follow each grammar's [type mappings](../reference/type-mappings.md).

## PostgreSQL

<<< ../../examples/postgres/schema/001-schema.sql

## MySQL

<<< ../../examples/mysql/schema/001-schema.sql

## SQLite

<<< ../../examples/sqlite/schema/001-schema.sql

SQLite enables foreign keys for each connection. The schema uses strict tables and stores JSON as text.

## Shared SQL functions

The PostgreSQL and MySQL playground workspaces also include `schema/functions.sql`, which declares `display_email(text)` using `lower()`. Imported SQL queries and TypeScript templates share that signature. SQLite uses the built-in `lower()` function because application-defined functions are registered by its connection, rather than declared with `CREATE FUNCTION`.

## Explore the queries

The [playground](../playground.md) opens this workspace by default, including imported SQL CTEs, tagged templates, nullable joins, mapped and fixed inserts, JSON documents, audit writes, batches, and transactions. Switch dialects to inspect native syntax and parameter types. MySQL writes use `execute()` because it has no PostgreSQL-style `RETURNING`; SQLite JSON writes explicitly serialize their payloads.

The [PostgreSQL](./postgresql.md), [MySQL](./mysql.md), and [SQLite](./sqlite.md) runnable applications exercise the same tables through their application-owned adapters.
