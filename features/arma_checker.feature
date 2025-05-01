# features/steam.feature
Feature: Steam Workshop Mod Update Checker

  Scenario: Verify mod update times against threshold
    Given I extract workshop IDs from XML file
    When I check each mod's last update time against {int} hours threshold
    Then I should see update status for all mods