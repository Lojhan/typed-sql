import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Real migration inputs shared by the interactive review and explorer browser tests. */
export const commerceNamespaces = ["public", "identity", "inventory", "sales", "billing", "audit", "analytics"];
export const commerceMigrations = [
  {
    id: "001_accounts_and_organizations",
    description: "Create accounts, organizations and composite organization memberships",
    up: `create type identity.account_status as enum ('invited', 'active', 'suspended');
create table public.accounts (id bigint primary key, display_name text not null);
create table identity.organizations (id bigint primary key, name text not null, slug text not null unique);
create table identity.memberships (
 organization_id bigint not null references identity.organizations(id),
 account_id bigint not null references public.accounts(id),
 role text not null default 'member', primary key (organization_id, account_id)
);`,
  },
  {
    id: "002_product_catalog",
    description: "Add a self-referencing category tree and product catalog",
    up: `create type inventory.product_status as enum ('draft', 'published', 'archived');
create table inventory.categories (id bigint primary key, parent_id bigint references inventory.categories(id), name text not null);
create table inventory.products (
 id bigint primary key, category_id bigint references inventory.categories(id),
 sku text not null unique, name text not null, price numeric(12,2) not null check (price >= 0),
 status inventory.product_status not null default 'draft'
);`,
  },
  {
    id: "003_orders_and_lines",
    description: "Connect customer orders, products and composite line references",
    up: `create type sales.order_status as enum ('draft', 'placed', 'paid', 'shipped', 'cancelled');
create table public.orders (id bigint primary key, account_id bigint not null references public.accounts(id), total numeric(12,2) not null);
create table sales.orders (
 id bigint primary key, account_id bigint not null references public.accounts(id),
 organization_id bigint not null references identity.organizations(id),
 status sales.order_status not null default 'draft', created_at timestamptz not null default now()
);
create table sales.order_lines (
 order_id bigint not null references sales.orders(id), line_no integer not null,
 product_id bigint not null references inventory.products(id), quantity integer not null check (quantity > 0),
 unit_price numeric(12,2) not null, primary key(order_id, line_no)
);
create table sales.line_adjustments (
 id bigint primary key, order_id bigint not null, line_no integer not null,
 amount numeric(12,2) not null, reason text not null,
 foreign key(order_id, line_no) references sales.order_lines(order_id, line_no)
);`,
  },
  {
    id: "004_account_profiles",
    description: "Evolve accounts with status, contact email and a unique lookup index",
    up: `alter table public.accounts add column status identity.account_status not null default 'active';
alter table public.accounts add column email text;
create unique index accounts_email_key on public.accounts (lower(email)) where email is not null;`,
  },
  {
    id: "005_stock_and_warehouses",
    description: "Track product stock and reservations across warehouses",
    up: `create table inventory.warehouses (id bigint primary key, name text not null, region text not null);
create table inventory.stock (
 warehouse_id bigint not null references inventory.warehouses(id),
 product_id bigint not null references inventory.products(id),
 available integer not null default 0 check (available >= 0),
 primary key (warehouse_id, product_id)
);
create table inventory.reservations (
 id bigint primary key, warehouse_id bigint not null, product_id bigint not null,
 order_id bigint not null references sales.orders(id), quantity integer not null check (quantity > 0),
 foreign key (warehouse_id, product_id) references inventory.stock(warehouse_id, product_id)
);`,
  },
  {
    id: "006_billing",
    description: "Add invoices, payments and payment state",
    up: `create type billing.payment_status as enum ('pending', 'settled', 'failed');
create table billing.invoices (
 id bigint primary key, order_id bigint not null unique references sales.orders(id),
 account_id bigint not null references public.accounts(id), amount numeric(12,2) not null,
 issued_at timestamptz not null default now()
);
create table billing.payments (
 id bigint primary key, invoice_id bigint not null references billing.invoices(id),
 status billing.payment_status not null default 'pending', amount numeric(12,2) not null,
 provider_reference text unique
);`,
  },
  {
    id: "007_query_indexes",
    description: "Add composite, partial, expression and covering query indexes",
    up: `create index orders_account_created_idx on sales.orders (account_id, created_at desc) include (status);
create index orders_open_idx on sales.orders (organization_id) where status in ('draft', 'placed');
create index products_name_lower_idx on inventory.products (lower(name));
create index payments_pending_idx on billing.payments (invoice_id) where status = 'pending';`,
  },
  {
    id: "008_audit_trail",
    description: "Capture account activity and searchable event metadata",
    up: `create type audit.event_kind as enum ('created', 'updated', 'deleted');
create table audit.events (
 id bigint primary key, actor_id bigint references public.accounts(id),
 organization_id bigint references identity.organizations(id),
 kind audit.event_kind not null, entity text not null, payload jsonb not null default '{}',
 occurred_at timestamptz not null default now()
);
create index events_payload_idx on audit.events using gin(payload);
create index events_actor_time_idx on audit.events (actor_id, occurred_at desc);`,
  },
  {
    id: "009_reporting_views",
    description: "Expose order totals and organization reporting views",
    up: `create view analytics.order_totals as
 select o.id as order_id, o.account_id, sum(l.quantity * l.unit_price) as total
 from sales.orders o join sales.order_lines l on l.order_id = o.id group by o.id, o.account_id;
create view analytics.organization_orders as
 select g.id as organization_id, g.name, count(o.id) as order_count
 from identity.organizations g left join sales.orders o on o.organization_id = g.id group by g.id, g.name;`,
  },
  {
    id: "010_contact_and_shipping",
    description: "Rename account email and evolve order shipping details",
    up: `alter table public.accounts rename column email to contact_email;
alter table sales.orders add column shipped_at timestamptz;
alter table sales.orders add constraint orders_shipping_time_check check (shipped_at is null or shipped_at >= created_at);
create index orders_shipping_idx on sales.orders (shipped_at) where shipped_at is not null;`,
  },
  {
    id: "011_payment_evolution",
    description: "Evolve payment statuses and replace the pending-payment index",
    up: `alter type billing.payment_status add value 'refunded';
drop index billing.payments_pending_idx;
create index payments_status_invoice_idx on billing.payments (status, invoice_id) include (amount);
alter table billing.payments add column settled_at timestamptz;`,
  },
  {
    id: "012_review_data",
    description: "Populate deterministic connected commerce review data",
    up: `insert into public.accounts(id, display_name, contact_email)
 select n, 'Account ' || n, 'account-' || n || '@example.test' from generate_series(1,1500) n;
insert into identity.organizations values (1,'Northstar','northstar'),(2,'Harbor Labs','harbor');
insert into identity.memberships select 1, n, 'member' from generate_series(1,100) n;
insert into inventory.categories values (1,null,'Equipment'),(2,1,'Studio'),(3,1,'Field');
insert into inventory.products select n, 2 + n % 2, 'SKU-' || n, 'Product ' || n, 10 + n, 'published' from generate_series(1,80) n;
insert into inventory.warehouses values (1,'Central','eu'),(2,'West','us');
insert into inventory.stock select 1,n,100 from generate_series(1,80) n;
insert into sales.orders(id,account_id,organization_id,status) select n,n,1,'placed' from generate_series(1,60) n;
insert into sales.order_lines select n,1,n,2,10+n from generate_series(1,60) n;
insert into public.orders select n,n,(10+n)*2 from generate_series(1,60) n;
insert into sales.line_adjustments values (1,1,1,-2,'Welcome discount');
insert into inventory.reservations values (1,1,1,1,2);
insert into billing.invoices(id,order_id,account_id,amount) select n,n,n,(10+n)*2 from generate_series(1,40) n;
insert into billing.payments(id,invoice_id,status,amount,provider_reference) select n,n,'settled',(10+n)*2,'payment-' || n from generate_series(1,30) n;
insert into audit.events(id,actor_id,organization_id,kind,entity,payload) select n,n,1,'created','account',jsonb_build_object('accountId',n) from generate_series(1,100) n;`,
  },
  {
    id: "013_account_last_seen",
    description: "Add account last-seen tracking (pending review)",
    up: "alter table public.accounts add column last_seen_at timestamptz;",
    pending: true,
  },
];

export async function writeCommerceMigrations(directory, { includePending = true } = {}) {
  for (const migration of commerceMigrations) {
    if (migration.pending && !includePending) continue;
    const folder = join(directory, migration.id);
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "migration.json"),
      `${JSON.stringify({ formatVersion: 1, id: migration.id, description: migration.description, up: "up.sql", irreversibleReason: "Review fixture: provision a new database to reset." }, null, 2)}\n`,
    );
    await writeFile(join(folder, "up.sql"), `${migration.up}\n`);
  }
}
