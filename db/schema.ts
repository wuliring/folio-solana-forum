import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const articles = sqliteTable("forum_articles", {
  signature: text("signature").primaryKey(),
  author: text("author").notNull(),
  title: text("title").notNull(),
  contentHash: text("content_hash").notNull(),
  body: text("body").notNull(),
  format: text("format").notNull().default("markdown"),
  createdAt: integer("created_at").notNull(),
}, table => [index("forum_articles_author").on(table.author)]);
