$ErrorActionPreference = "Stop"

function Assert-TestEqual($Actual, $Expected, [string]$Label) {
    if ($Actual -ne $Expected) {
        throw "$Label expected '$Expected', received '$Actual'"
    }
}

Add-Type -TypeDefinition @"
using System.Collections;
using System.Collections.Generic;

public sealed class TerminalXRenderTestCounter {
    public int FindAll;
    public int FindAllDescendants;
    public int WalkerSteps;
}

public sealed class TerminalXRenderTestWalker {
    public TerminalXRenderTestCounter Counter = new TerminalXRenderTestCounter();

    public TerminalXRenderTestElement GetFirstChild(TerminalXRenderTestElement node) {
        Counter.WalkerSteps++;
        if (node == null || node.FailFindAll || node.Children.Count == 0) {
            return null;
        }
        return node.Children[0];
    }

    public TerminalXRenderTestElement GetNextSibling(TerminalXRenderTestElement node) {
        Counter.WalkerSteps++;
        if (node == null || node.Parent == null) {
            return null;
        }
        int index = node.Parent.Children.IndexOf(node);
        if (index < 0 || index + 1 >= node.Parent.Children.Count) {
            return null;
        }
        return node.Parent.Children[index + 1];
    }
}

public sealed class TerminalXRenderTestBounds {
    public bool IsEmpty = true;
    public double X;
    public double Y;
    public double Width;
    public double Height;
}

public sealed class TerminalXRenderTestControlType {
    public string ProgrammaticName = "";
}

public sealed class TerminalXRenderTestCurrent {
    public string AutomationId = "";
    public TerminalXRenderTestBounds BoundingRectangle = new TerminalXRenderTestBounds();
    public string ClassName = "fake";
    public TerminalXRenderTestControlType ControlType = new TerminalXRenderTestControlType();
    public bool IsPassword;
    public string LocalizedControlType = "";
    public string Name = "";
    public long NativeWindowHandle;
}

public sealed class TerminalXRenderTestPatternCurrent {
    public bool IsSelected;
    public string Value = "";
}

public sealed class TerminalXRenderTestPattern {
    public TerminalXRenderTestPatternCurrent Current = new TerminalXRenderTestPatternCurrent();
}

public sealed class TerminalXRenderTestCollection : IEnumerable {
    private readonly TerminalXRenderTestElement[] values;

    public TerminalXRenderTestCollection(TerminalXRenderTestElement[] values) {
        this.values = values;
    }

    public int Count {
        get { return values.Length; }
    }

    public TerminalXRenderTestElement Item(int index) {
        return values[index];
    }

    public IEnumerator GetEnumerator() {
        return values.GetEnumerator();
    }
}

public sealed class TerminalXRenderTestElement {
    public readonly List<TerminalXRenderTestElement> Children =
        new List<TerminalXRenderTestElement>();
    public TerminalXRenderTestElement Parent;
    public TerminalXRenderTestCounter Counter = new TerminalXRenderTestCounter();
    public readonly TerminalXRenderTestCurrent Current = new TerminalXRenderTestCurrent();
    public bool FailFindAll;
    public int RuntimeIdValue;
    public string ValueText = "";

    public TerminalXRenderTestCollection FindAll(object scope, object condition) {
        if (scope != null && scope.ToString() == "Descendants") {
            Counter.FindAllDescendants++;
            throw new System.InvalidOperationException("unbounded Descendants scan is forbidden");
        }
        Counter.FindAll++;
        if (FailFindAll) {
            throw new System.InvalidOperationException("defunct node");
        }
        return new TerminalXRenderTestCollection(Children.ToArray());
    }

    public TerminalXRenderTestPattern GetCurrentPattern(object pattern) {
        TerminalXRenderTestPattern result = new TerminalXRenderTestPattern();
        result.Current.Value = ValueText;
        return result;
    }

    public int[] GetRuntimeId() {
        return new int[] { RuntimeIdValue };
    }

    public object[] GetSupportedPatterns() {
        return new object[0];
    }
}
"@

function New-TestCounter {
    New-Object -TypeName TerminalXRenderTestCounter
}

function New-TestElement {
    param(
        [string]$Role,
        [string]$Name = "",
        [string]$Value = "",
        [object[]]$Children = @(),
        $Counter = $(New-TestCounter),
        [switch]$FailFindAll,
        [int]$RuntimeId = 1
    )
    $element = New-Object -TypeName TerminalXRenderTestElement
    $element.Counter = $Counter
    $element.FailFindAll = [bool]$FailFindAll
    $element.RuntimeIdValue = $RuntimeId
    $element.ValueText = $Value
    $element.Current.ControlType.ProgrammaticName = $Role
    $element.Current.LocalizedControlType = $Role
    $element.Current.Name = $Name
    foreach ($child in @($Children)) {
        $child.Parent = $element
        [void]$element.Children.Add($child)
    }
    $element
}

$operationPath = Join-Path ([IO.Path]::GetTempPath()) ("terminalx-runtime-render-test-" + [guid]::NewGuid() + ".json")
try {
    Set-Content -LiteralPath $operationPath -Encoding UTF8 -Value '{"tool":"handshake"}'
    $runtimeOutput = . (Join-Path $PSScriptRoot "runtime.ps1") -OperationPath $operationPath
    $handshake = $runtimeOutput | ConvertFrom-Json
    Assert-TestEqual $handshake.ok $true "runtime handshake"

    $counter = New-TestCounter
    $leaf = New-TestElement -Role "text" -Name "unused" -Counter $counter -RuntimeId 2
    $root = New-TestElement -Role "button" -Name "Save" -Children @($leaf) -Counter $counter
    $tree = Render-TerminalXTree $root $null
    Assert-TestEqual $tree.elements.Count 1 "named control record count"
    Assert-TestEqual ([string]$tree.lines[0]) "0 button Save" "named control line"
    Assert-TestEqual $counter.FindAll 0 "named control skips child enumeration"

    $counter = New-TestCounter
    $leaf = New-TestElement -Role "text" -Name "body" -Counter $counter -RuntimeId 2
    $root = New-TestElement -Role "group" -Name "Details" -Children @($leaf) -Counter $counter
    $tree = Render-TerminalXTree $root $null
    Assert-TestEqual (($tree.elements | ForEach-Object { $_.name }) -join "|") "Details|body" "named generic records"
    Assert-TestEqual (@($tree.lines) -join "|") "0 group Details|`t1 text body" "named generic lines"
    Assert-TestEqual $counter.FindAll 2 "named generic child enumeration"

    $counter = New-TestCounter
    $alpha = New-TestElement -Role "text" -Name "Alpha" -Counter $counter -RuntimeId 2
    $beta = New-TestElement -Role "text" -Name "Beta" -Counter $counter -RuntimeId 3
    $root = New-TestElement -Role "group" -Children @($alpha, $beta) -Counter $counter
    $tree = Render-TerminalXTree $root $null
    Assert-TestEqual $tree.elements.Count 1 "anonymous generic record count"
    Assert-TestEqual ([string]$tree.lines[0]) "0 group, Text: Alpha Beta" "anonymous generic summary"
    Assert-TestEqual $counter.FindAll 3 "anonymous generic single-pass child enumeration"

    $counter = New-TestCounter
    $alpha = New-TestElement -Role "text" -Name "Alpha" -Counter $counter -RuntimeId 2
    $beta = New-TestElement -Role "text" -Name "Beta" -Counter $counter -RuntimeId 3
    $root = New-TestElement -Role "row" -Name "Invoice" -Children @($alpha, $beta) -Counter $counter
    $tree = Render-TerminalXTree $root $null
    Assert-TestEqual (($tree.elements | ForEach-Object { $_.name }) -join "|") "Invoice|Alpha|Beta" "row records"
    Assert-TestEqual ([string]$tree.lines[0]) "0 row Invoice, Text: Alpha Beta" "row summary"
    Assert-TestEqual $counter.FindAll 3 "row single-pass child enumeration"

    $counter = New-TestCounter
    $button = New-TestElement -Role "button" -Name "Continue" -Counter $counter -RuntimeId 2
    $root = New-TestElement -Role "group" -Children @($button) -Counter $counter
    $tree = Render-TerminalXTree $root $null
    Assert-TestEqual $tree.elements.Count 1 "elided wrapper record count"
    Assert-TestEqual ([string]$tree.lines[0]) "0 button Continue" "elided wrapper line"
    Assert-TestEqual $counter.FindAll 1 "elided wrapper single-pass child enumeration"

    $counter = New-TestCounter
    $root = New-TestElement -Role "row" -Name "Invoice" -Counter $counter -FailFindAll
    $tree = Render-TerminalXTree $root $null
    Assert-TestEqual $tree.elements.Count 1 "failed child read record count"
    Assert-TestEqual ([string]$tree.lines[0]) "0 row Invoice" "failed child read line"
    Assert-TestEqual $counter.FindAll 1 "failed child read cached without retry"

    # P-16: nested depth-4 generic containers must not re-walk subtrees.
    $counter = New-TestCounter
    $btn = New-TestElement -Role "button" -Name "Submit" -Counter $counter -RuntimeId 10
    $hint = New-TestElement -Role "text" -Name "Hint" -Counter $counter -RuntimeId 11
    $inner = New-TestElement -Role "group" -Children @($btn, $hint) -Counter $counter -RuntimeId 12
    $lvl3 = New-TestElement -Role "group" -Children @($inner) -Counter $counter -RuntimeId 13
    $lvl2 = New-TestElement -Role "group" -Children @($lvl3) -Counter $counter -RuntimeId 14
    $lvl1 = New-TestElement -Role "group" -Children @($lvl2) -Counter $counter -RuntimeId 15
    $root = New-TestElement -Role "pane" -Children @($lvl1) -Counter $counter -RuntimeId 16
    $tree = Render-TerminalXTree $root $null
    Assert-TestEqual (($tree.elements | ForEach-Object { $_.name }) -join "|") "|Submit|Hint" "nested generic records"
    Assert-TestEqual $counter.FindAll 6 "nested depth-4 generic single-pass child enumeration"

    # P-16: Find-TerminalXElement uses bounded TreeWalker without TreeScope::Descendants.
    $counter = New-TestCounter
    $walker = New-Object -TypeName TerminalXRenderTestWalker
    $walker.Counter = $counter
    $siblings = @()
    for ($i = 0; $i -lt 25; $i++) {
        $siblings += New-TestElement -Role "button" -Name "Btn $i" -Counter $counter -RuntimeId (100 + $i)
    }
    $root = New-TestElement -Role "window" -Name "Main" -Children $siblings -Counter $counter -RuntimeId 1
    $found = Find-TerminalXElement $root ([pscustomobject]@{ index = 4; runtimeId = @(103) }) $walker
    Assert-TestEqual ($null -ne $found) $true "bounded TreeWalker finds target"
    Assert-TestEqual $found.Current.Name "Btn 3" "bounded TreeWalker matched element"
    Assert-TestEqual $counter.FindAllDescendants 0 "Find-TerminalXElement never calls Descendants"
    Assert-TestEqual $counter.FindAll 0 "Find-TerminalXElement uses TreeWalker instead of FindAll"
    Assert-TestEqual $counter.WalkerSteps 4 "Find-TerminalXElement exits early on match"

    $originalMaxNodesForFind = $MaxNodes
    try {
        $MaxNodes = 5
        $missing = Find-TerminalXElement $root ([pscustomobject]@{ index = 20; runtimeId = @(120) }) $walker
        Assert-TestEqual ($null -eq $missing) $true "Find-TerminalXElement respects MaxNodes cap"
    } finally {
        $MaxNodes = $originalMaxNodesForFind
    }

    # P-16: Win32 DLL cache key & cache path verification.
    $keyA = Get-TerminalXWin32CacheKey "public class A {}"
    $keyA2 = Get-TerminalXWin32CacheKey "public class A {}"
    $keyB = Get-TerminalXWin32CacheKey "public class B {}"
    Assert-TestEqual $keyA $keyA2 "Win32 cache key deterministic"
    if ($keyA -eq $keyB) {
        throw "Win32 cache key must change when source changes"
    }
    $defaultDllPath = Get-TerminalXWin32CachePath
    Assert-TestEqual ([System.IO.File]::Exists($defaultDllPath)) $true "Win32 cached DLL exists after startup"

    $originalMaxNodes = $MaxNodes
    try {
        $MaxNodes = 3
        $counter = New-TestCounter
        $children = @()
        for ($index = 0; $index -lt 3; $index++) {
            $children += New-TestElement -Role "text" -Name "Item $index" -Counter $counter -RuntimeId ($index + 2)
        }
        $root = New-TestElement -Role "document" -Name "Results" -Children $children -Counter $counter
        $tree = Render-TerminalXTree $root $null
        Assert-TestEqual $tree.elements.Count 3 "node limit record count"
        Assert-TestEqual ([string]$tree.elements[-1].name) "Item 1" "node limit prefix"
        Assert-TestEqual $tree.truncation.truncated $true "node limit truncation"
        Assert-TestEqual $tree.truncation.maxDepthReached $false "node limit depth flag"
    } finally {
        $MaxNodes = $originalMaxNodes
    }

    $originalMaxDepth = $MaxDepth
    try {
        $MaxDepth = 2
        $counter = New-TestCounter
        $root = New-TestElement -Role "document" -Name "Depth 3" -Counter $counter -RuntimeId 4
        for ($depth = 2; $depth -ge 0; $depth--) {
            $root = New-TestElement -Role "document" -Name "Depth $depth" -Children @($root) -Counter $counter -RuntimeId ($depth + 1)
        }
        $tree = Render-TerminalXTree $root $null
        Assert-TestEqual $tree.elements.Count 3 "depth limit record count"
        Assert-TestEqual ([string]$tree.elements[-1].name) "Depth 2" "depth limit prefix"
        Assert-TestEqual $tree.truncation.truncated $true "depth limit truncation"
        Assert-TestEqual $tree.truncation.maxDepthReached $true "depth limit flag"
    } finally {
        $MaxDepth = $originalMaxDepth
    }

    # S-18: own_app_protected guard rejects TerminalX/Raccoon/owner PID/release bundle id
    $ownApp = [pscustomobject]@{
        pid = 9999
        executablePath = "C:\Program Files\TerminalX\terminalx.exe"
        executableName = "terminalx"
        appIdentifier = "com.terminalx.dev"
        releaseBundleId = "com.terminalx.next"
        appNames = @("TerminalX", "Raccoon")
        windowClasses = @("terminalx", "raccoon")
        allowOwnWindowsForTests = $false
    }
    Assert-TestEqual (Test-TerminalXOwnAppIdentity -TargetPid 9999 -Names @("CustomHost") -OwnApp $ownApp) $true "own app owner pid blocked"
    Assert-TestEqual (Test-TerminalXOwnAppIdentity -TargetPid 42 -Names @("TerminalX") -OwnApp $ownApp) $true "own app name blocked"
    Assert-TestEqual (Test-TerminalXOwnAppIdentity -TargetPid 42 -Names @("Raccoon") -OwnApp $ownApp) $true "own app raccoon blocked"
    Assert-TestEqual (Test-TerminalXOwnAppIdentity -TargetPid 42 -Names @("com.terminalx.next") -OwnApp $ownApp) $true "own app release bundle blocked"
    Assert-TestEqual (Test-TerminalXOwnAppIdentity -TargetPid 42 -Names @("Notepad") -OwnApp $ownApp) $false "benign app allowed"

    foreach ($selector in @("TerminalX", "Raccoon", "com.terminalx.next", "pid:9999", "9999")) {
        $threwOwn = $false
        try {
            Assert-TerminalXQueryAllowed $selector $ownApp
        } catch {
            if ($_.Exception.Message -like "own_app_protected:*") { $threwOwn = $true }
        }
        Assert-TestEqual $threwOwn $true "query '$selector' rejected with own_app_protected"
    }

    # S-26: coordinate bounds enforcement
    $frame = New-TerminalXFrame 100 200 300 200
    $validPt = Get-TerminalXScreenPoint ([pscustomobject]@{ x = 50; y = 75; element = $null }) $frame
    Assert-TestEqual $validPt.x 150 "in-bounds screen x"
    Assert-TestEqual $validPt.y 275 "in-bounds screen y"
    foreach ($bad in @(@(-1, 10), @(10, -1), @(301, 10), @(10, 201))) {
        $threwBounds = $false
        try {
            [void](Get-TerminalXScreenPoint ([pscustomobject]@{ x = $bad[0]; y = $bad[1]; element = $null }) $frame)
        } catch {
            if ($_.Exception.Message -like "*out of window bounds*") { $threwBounds = $true }
        }
        Assert-TestEqual $threwBounds $true "out-of-bounds ($($bad[0]), $($bad[1])) rejected"
    }

    # S-26: topmost-window hit-test verification
    $fakeTarget = [pscustomobject]@{ Id = 5555; ProcessName = "notepad"; MainWindowTitle = "Notes"; MainWindowHandle = 12345 }
    $origHitTest = Get-Item Function:\Get-TerminalXTopLevelWindowAtPoint
    try {
        function Get-TerminalXTopLevelWindowAtPoint([int]$ScreenX, [int]$ScreenY) {
            [pscustomobject]@{ hwnd = [IntPtr]12345; pid = 5555; processName = "notepad"; executablePath = ""; className = "Notepad"; title = "Notes" }
        }
        Assert-TerminalXScreenPointOwnedByTarget $fakeTarget ([IntPtr]12345) $frame 150 250 $ownApp

        function Get-TerminalXTopLevelWindowAtPoint([int]$ScreenX, [int]$ScreenY) {
            [pscustomobject]@{ hwnd = [IntPtr]99999; pid = 9999; processName = "terminalx"; executablePath = ""; className = "TerminalX"; title = "Confirm" }
        }
        $threwOccludedTx = $false
        try { Assert-TerminalXScreenPointOwnedByTarget $fakeTarget ([IntPtr]12345) $frame 150 250 $ownApp } catch {
            if ($_.Exception.Message -like "own_app_protected:*") { $threwOccludedTx = $true }
        }
        Assert-TestEqual $threwOccludedTx $true "hit-test rejects TerminalX occlusion"

        function Get-TerminalXTopLevelWindowAtPoint([int]$ScreenX, [int]$ScreenY) {
            [pscustomobject]@{ hwnd = [IntPtr]88888; pid = 7777; processName = "1Password"; executablePath = ""; className = "1Password"; title = "Vault" }
        }
        $threwOccludedPw = $false
        try { Assert-TerminalXScreenPointOwnedByTarget $fakeTarget ([IntPtr]12345) $frame 150 250 $ownApp } catch {
            if ($_.Exception.Message -like "appBlocked*") { $threwOccludedPw = $true }
        }
        Assert-TestEqual $threwOccludedPw $true "hit-test rejects password manager occlusion"

        function Get-TerminalXTopLevelWindowAtPoint([int]$ScreenX, [int]$ScreenY) {
            [pscustomobject]@{ hwnd = [IntPtr]77777; pid = 8888; processName = "otherapp"; executablePath = ""; className = "Other"; title = "Other" }
        }
        $threwOccludedOther = $false
        try { Assert-TerminalXScreenPointOwnedByTarget $fakeTarget ([IntPtr]12345) $frame 150 250 $ownApp } catch {
            if ($_.Exception.Message -like "*occluded by another window*") { $threwOccludedOther = $true }
        }
        Assert-TestEqual $threwOccludedOther $true "hit-test rejects unrelated occluding window"
    } finally {
        Set-Item Function:\Get-TerminalXTopLevelWindowAtPoint $origHitTest.ScriptBlock
    }

    Write-Output "windows-snapshot-render-tests-ok"
} finally {
    Remove-Item -LiteralPath $operationPath -Force -ErrorAction SilentlyContinue
}
