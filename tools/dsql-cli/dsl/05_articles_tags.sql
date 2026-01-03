-- Create articles_tags junction table (many-to-many relationship)
CREATE TABLE app.articles_tags (
    article_id UUID NOT NULL,
    tag_id UUID NOT NULL,
    PRIMARY KEY (article_id, tag_id)
);
