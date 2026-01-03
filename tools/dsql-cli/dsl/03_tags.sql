-- Create tags table
CREATE TABLE app.tags (
    tag_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE
);
