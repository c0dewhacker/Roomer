-- Privacy opt-out for the colleague finder / "who's in" directory.
ALTER TABLE "User" ADD COLUMN "visibleInColleagueSearch" BOOLEAN NOT NULL DEFAULT true;
