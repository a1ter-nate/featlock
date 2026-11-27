module featlock_guards {
  type FeatureStatus = "active" | "deprecated" | "removed"

  pure def allowsDirectSqlDelete(status: FeatureStatus): bool =
    status != "active"

  pure def allowsRemovalTransition(
    prevStatus: FeatureStatus,
    nextStatus: FeatureStatus,
    hasAdr: bool,
    hasReason: bool,
    allowRemovalFlag: bool
  ): bool =
    if (prevStatus != "active") true
    else if (nextStatus != "removed") true
    else hasAdr and hasReason and allowRemovalFlag

  pure def canDisablePlugin(isGuarded: bool, removeRequested: bool): bool =
    if (isGuarded) false
    else removeRequested

  var featureStatus: FeatureStatus
  var guardedPluginActive: bool
  var lastTransitionValid: bool

  action init = all {
    featureStatus' = "active",
    guardedPluginActive' = true,
    lastTransitionValid' = true,
  }

  action stepDeprecate = all {
    featureStatus == "active",
    featureStatus' = "deprecated",
    guardedPluginActive' = true,
    lastTransitionValid' = true,
  }

  action stepApprovedRemove = all {
    featureStatus == "active",
    allowsRemovalTransition("active", "removed", true, true, true),
    featureStatus' = "removed",
    guardedPluginActive' = true,
    lastTransitionValid' = true,
  }

  action stepRejectDisableGuarded = all {
    not(canDisablePlugin(true, true)),
    featureStatus' = featureStatus,
    guardedPluginActive' = true,
    lastTransitionValid' = true,
  }

  val antiDeletionInvariant =
    (featureStatus != "active" or not(allowsDirectSqlDelete(featureStatus)))
    and lastTransitionValid

  val guardedPluginInvariant = guardedPluginActive
}
