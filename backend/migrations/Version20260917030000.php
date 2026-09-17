<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Adds the `tag` reference table (composite `(dimension, value)` primary
 * key, see `App\Entity\Tag`) and the `line_tag` many-to-many join table
 * between `line` and `tag` — see CLAUDE.md's "Tags" section for why tags
 * live on the line rather than the transaction, and why both `dimension`
 * and `value` are open, find-or-create strings rather than a curated set.
 *
 * Pure additions, no backfill — this is a brand-new, currently-empty
 * feature; no existing line needs a tag retroactively.
 */
final class Version20260917030000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Add tag and line_tag tables.';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE tag (dimension VARCHAR(255) NOT NULL, value VARCHAR(255) NOT NULL, PRIMARY KEY(dimension, value))');
        $this->addSql('CREATE TABLE line_tag (line_id INTEGER NOT NULL, tag_dimension VARCHAR(255) NOT NULL, tag_value VARCHAR(255) NOT NULL, PRIMARY KEY(line_id, tag_dimension, tag_value), CONSTRAINT FK_LINE_TAG_LINE FOREIGN KEY (line_id) REFERENCES line (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_LINE_TAG_TAG FOREIGN KEY (tag_dimension, tag_value) REFERENCES tag (dimension, value) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('CREATE INDEX IDX_LINE_TAG_TAG ON line_tag (tag_dimension, tag_value)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE line_tag');
        $this->addSql('DROP TABLE tag');
    }
}
