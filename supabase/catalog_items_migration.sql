-- Product and repair-type lists shown as buttons in the intake form.
-- Run once in the Supabase SQL editor.
CREATE TABLE IF NOT EXISTS catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('product', 'work')),
  name text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (kind, name)
);

ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access" ON catalog_items
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
