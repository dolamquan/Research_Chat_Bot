from pathlib import Path

from app.rag.visual_analyzer import VISUAL_ASSET_DIR
from app.storage.visual_assets import migrate_visual_asset_files_to_db


def main() -> None:
    result = migrate_visual_asset_files_to_db(
        visual_asset_dir=Path(VISUAL_ASSET_DIR),
        delete_files=True,
    )
    message = (
        "Migrated {migrated} visual assets into SQLite; "
        "deleted {deleted} files; {missing} records had no file/blob."
    )
    print(message.format(**result))


if __name__ == "__main__":
    main()
