PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS athlete (
  id INTEGER PRIMARY KEY,
  student_no TEXT NOT NULL UNIQUE,
  bib_number TEXT UNIQUE,
  name TEXT NOT NULL,
  class_name TEXT NOT NULL,
  grade INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 6),
  gender TEXT NOT NULL CHECK (gender IN ('male', 'female'))
);

CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('track', 'field')),
  gender_group TEXT NOT NULL CHECK (gender_group IN ('male', 'female')),
  is_team INTEGER NOT NULL DEFAULT 0 CHECK (is_team IN (0, 1)),
  unit TEXT NOT NULL CHECK (length(trim(unit)) > 0),
  UNIQUE (name, gender_group)
);

CREATE TABLE IF NOT EXISTS registration (
  id INTEGER PRIMARY KEY,
  athlete_id INTEGER NOT NULL REFERENCES athlete(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (athlete_id, event_id)
);

CREATE TRIGGER IF NOT EXISTS registration_max_two_insert
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
    THEN RAISE(ABORT, '每名运动员最多报名2个项目')
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

CREATE TRIGGER IF NOT EXISTS registration_max_two_update
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
    THEN RAISE(ABORT, '每名运动员最多报名2个项目')
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

CREATE TRIGGER IF NOT EXISTS athlete_gender_matches_registrations
BEFORE UPDATE OF gender ON athlete
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM registration r
  JOIN event e ON e.id = r.event_id
  WHERE r.athlete_id = OLD.id AND e.gender_group <> NEW.gender
)
BEGIN
  SELECT RAISE(ABORT, '已有报名记录，不能更改为不匹配的性别');
END;

CREATE TRIGGER IF NOT EXISTS event_gender_matches_registrations
BEFORE UPDATE OF gender_group ON event
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM registration r
  JOIN athlete a ON a.id = r.athlete_id
  WHERE r.event_id = OLD.id AND a.gender <> NEW.gender_group
)
BEGIN
  SELECT RAISE(ABORT, '已有报名记录，不能更改为不匹配的组别');
END;

CREATE TRIGGER IF NOT EXISTS event_team_flag_preserves_registration_limit
BEFORE UPDATE OF is_team ON event
FOR EACH ROW
WHEN OLD.is_team = 1 AND NEW.is_team = 0
  AND EXISTS (
    SELECT 1
    FROM registration current_registration
    WHERE current_registration.event_id = OLD.id
      AND (
        SELECT COUNT(*)
        FROM registration r
        JOIN event e ON e.id = r.event_id
        WHERE r.athlete_id = current_registration.athlete_id
          AND e.is_team = 0
      ) >= 2
  )
BEGIN
  SELECT RAISE(ABORT, '更改为单项后会超过每人2项的报名限制');
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

CREATE TABLE IF NOT EXISTS heat (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  athlete_id INTEGER NOT NULL REFERENCES athlete(id) ON DELETE CASCADE,
  round TEXT NOT NULL CHECK (round IN ('preliminary', 'final')),
  group_number INTEGER NOT NULL CHECK (group_number > 0),
  position_number INTEGER NOT NULL CHECK (position_number > 0),
  UNIQUE (event_id, round, athlete_id),
  UNIQUE (event_id, round, group_number, position_number)
);

CREATE TRIGGER IF NOT EXISTS heat_requires_registration
BEFORE INSERT ON heat
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM registration
  WHERE athlete_id = NEW.athlete_id AND event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, '分组运动员必须已报名该项目');
END;

CREATE TRIGGER IF NOT EXISTS heat_registration_update
BEFORE UPDATE OF event_id, athlete_id ON heat
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM registration
  WHERE athlete_id = NEW.athlete_id AND event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, '分组运动员必须已报名该项目');
END;

CREATE TABLE IF NOT EXISTS result (
  id INTEGER PRIMARY KEY,
  registration_id INTEGER NOT NULL REFERENCES registration(id) ON DELETE CASCADE,
  heat_id INTEGER NOT NULL REFERENCES heat(id) ON DELETE CASCADE,
  value REAL NOT NULL CHECK (value >= 0),
  unit TEXT NOT NULL CHECK (length(trim(unit)) > 0),
  attempts_json TEXT NOT NULL DEFAULT '[]',
  rank INTEGER CHECK (rank IS NULL OR rank > 0),
  points REAL NOT NULL DEFAULT 0 CHECK (points >= 0),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (registration_id, heat_id)
);

CREATE TRIGGER IF NOT EXISTS result_matches_registration_and_heat
BEFORE INSERT ON result
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM registration r
  JOIN heat h ON h.id = NEW.heat_id
  JOIN event e ON e.id = h.event_id
  WHERE r.id = NEW.registration_id
    AND r.athlete_id = h.athlete_id
    AND r.event_id = h.event_id
    AND e.unit = NEW.unit
)
BEGIN
  SELECT RAISE(ABORT, '成绩、报名、分组运动员或计量单位不匹配');
END;

CREATE TRIGGER IF NOT EXISTS result_matches_registration_and_heat_update
BEFORE UPDATE OF registration_id, heat_id, unit ON result
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM registration r
  JOIN heat h ON h.id = NEW.heat_id
  JOIN event e ON e.id = h.event_id
  WHERE r.id = NEW.registration_id
    AND r.athlete_id = h.athlete_id
    AND r.event_id = h.event_id
    AND e.unit = NEW.unit
)
BEGIN
  SELECT RAISE(ABORT, '成绩、报名、分组运动员或计量单位不匹配');
END;

CREATE INDEX IF NOT EXISTS registration_event_idx ON registration(event_id);
CREATE INDEX IF NOT EXISTS heat_event_round_group_idx
  ON heat(event_id, round, group_number);
CREATE INDEX IF NOT EXISTS result_rank_idx ON result(heat_id, rank);
