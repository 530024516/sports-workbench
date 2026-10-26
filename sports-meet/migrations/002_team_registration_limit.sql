PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

DROP TRIGGER IF EXISTS registration_max_two_insert;
DROP TRIGGER IF EXISTS registration_max_two_update;

CREATE TRIGGER registration_max_two_insert
BEFORE INSERT ON registration
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN COALESCE((SELECT is_team FROM event WHERE id = NEW.event_id), 0) = 0
      AND (
        SELECT COUNT(*)
        FROM registration r
        JOIN event e ON e.id = r.event_id
        WHERE r.athlete_id = NEW.athlete_id AND e.is_team = 0
      ) >= 2
    THEN RAISE(ABORT, '每名运动员最多报名2个单项')
  END;
  SELECT CASE
    WHEN COALESCE((SELECT is_team FROM event WHERE id = NEW.event_id), 0) = 1
      AND (
        SELECT COUNT(*)
        FROM registration r
        JOIN event e ON e.id = r.event_id
        WHERE r.athlete_id = NEW.athlete_id AND e.is_team = 1
      ) >= 1
    THEN RAISE(ABORT, '每名运动员最多报名1个团队项目')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM athlete a
      JOIN event e ON e.id = NEW.event_id
      WHERE a.id = NEW.athlete_id AND a.gender = e.gender_group
    )
    THEN RAISE(ABORT, '运动员性别与项目组别不匹配')
  END;
END;

CREATE TRIGGER registration_max_two_update
BEFORE UPDATE OF athlete_id, event_id ON registration
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN COALESCE((SELECT is_team FROM event WHERE id = NEW.event_id), 0) = 0
      AND (
        SELECT COUNT(*)
        FROM registration r
        JOIN event e ON e.id = r.event_id
        WHERE r.athlete_id = NEW.athlete_id
          AND r.id <> OLD.id
          AND e.is_team = 0
      ) >= 2
    THEN RAISE(ABORT, '每名运动员最多报名2个单项')
  END;
  SELECT CASE
    WHEN COALESCE((SELECT is_team FROM event WHERE id = NEW.event_id), 0) = 1
      AND (
        SELECT COUNT(*)
        FROM registration r
        JOIN event e ON e.id = r.event_id
        WHERE r.athlete_id = NEW.athlete_id
          AND r.id <> OLD.id
          AND e.is_team = 1
      ) >= 1
    THEN RAISE(ABORT, '每名运动员最多报名1个团队项目')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM athlete a
      JOIN event e ON e.id = NEW.event_id
      WHERE a.id = NEW.athlete_id AND a.gender = e.gender_group
    )
    THEN RAISE(ABORT, '运动员性别与项目组别不匹配')
  END;
END;

CREATE TRIGGER IF NOT EXISTS event_team_flag_preserves_team_limit
BEFORE UPDATE OF is_team ON event
FOR EACH ROW
WHEN OLD.is_team = 0 AND NEW.is_team = 1
  AND EXISTS (
    SELECT 1
    FROM registration current_registration
    WHERE current_registration.event_id = OLD.id
      AND (
        SELECT COUNT(*)
        FROM registration r
        JOIN event e ON e.id = r.event_id
        WHERE r.athlete_id = current_registration.athlete_id
          AND e.is_team = 1
      ) >= 1
  )
BEGIN
  SELECT RAISE(ABORT, '更改为团队项目后会超过每人1项的报名限制');
END;

COMMIT;
